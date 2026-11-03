import { Readable, pipeline } from "node:stream";
import {
  DEFAULT_INGEST_LIMITS,
  extractIsolated,
  IngestRejected,
  ingestAttachment,
  kindForMime,
  sanitizeImage,
  UploadInspector,
  type IngestLimits,
  type Logger,
  type ModelCaller,
  type PromptSource,
} from "@aidp/ai";
import { currentTenant, tenantTransaction } from "@aidp/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { voiceAllowedForSession } from "../settings/features.js";
import type { SettingsService } from "../settings/service.js";
import { attachmentKey, ObjectTooLarge, type StoragePort } from "../storage/index.js";
import { CeilingReachedError, type TenantCeilings } from "../tenancy/ceilings.js";

/**
 * Attachments, from upload to retrieval (FR-30, FR-31, FR-32).
 *
 * Two things happen at different times on purpose. The upload is synchronous, because the
 * participant is waiting and needs to be told immediately whether the file was accepted. Reading
 * it — extraction, a vision call, a summary, chunking, embeddings — is a job, because it takes
 * seconds and the participant should be answering the next question while it runs.
 *
 * That split is why `Attachment.status` exists. Between the two there is a row with no text, and
 * the interface says "still reading that" rather than pretending the file is already useful.
 */

export interface AttachmentServiceDeps {
  db: PrismaClient;
  storage: StoragePort;
  settings: SettingsService;
  log: Logger;
  /** Absent in the API, which only stores and enqueues; the worker supplies it to ingest. */
  caller?: ModelCaller;
  prompts?: PromptSource;
  /**
   * The operator's storage ceiling for the tenant (D-229). Absent in tools that never enforce one;
   * the API always passes it, so an upload cannot take a tenant past what it was promised.
   */
  ceilings?: TenantCeilings;
  now?: () => Date;
}

export interface CreateAttachmentInput {
  companyId: string;
  sessionId: string;
  filename: string;
  mime: string;
  bytes: Buffer;
  /** Set for a voice recording, which is timed in the browser. */
  durationMs?: number;
}

export interface CreateAttachmentStreamInput {
  companyId: string;
  sessionId: string;
  filename: string;
  mime: string;
  /** The upload as it arrives. Never buffered here: it is inspected and written as it flows. */
  stream: Readable;
  durationMs?: number;
}

export interface AttachmentView {
  id: string;
  kind: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  status: string;
  summary: string | null;
  error: string | null;
  durationMs: number | null;
  /** The message this was recorded or sent with, when there is one (a spoken answer's audio). */
  messageId: string | null;
  createdAt: string;
}

/** Thrown when an upload is refused. The message is shown to the participant, so it is plain. */
export class AttachmentRejected extends Error {
  constructor(
    readonly reason: "type" | "size" | "disabled" | "session" | "quota" | "count",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentRejected";
  }
}

/**
 * Reduces an uploaded filename to something inert.
 *
 * The name comes from whoever uploaded the file and is echoed back to a browser, put in a
 * `Content-Disposition` header and shown in the interviewer's prompt. An allow-list rather than a
 * deny-list, because the list of characters that are harmless is short and knowable while the list
 * that is not keeps growing: path separators, control characters, quotes that escape the header,
 * and the right-to-left override that makes `evil\u202egnp.exe` read as a PNG.
 *
 * Letters and digits in any script are kept, so a Finnish or Arabic filename survives intact.
 */
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "file";
  const cleaned = base
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();
  return (cleaned.length > 0 ? cleaned : "file").slice(0, 200);
}

const MB = 1024 * 1024;

/** @fastify/multipart's own limit error, which reaches the stream as it is cut off. */
function isRequestTooLarge(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE"
  );
}

export class AttachmentService {
  private readonly now: () => Date;
  constructor(private readonly deps: AttachmentServiceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  /**
   * Validates, stores the bytes and records the row, from bytes already in memory. Voice uploads
   * come through here; the file route uses {@link createFromStream} directly.
   */
  async create(input: CreateAttachmentInput): Promise<AttachmentView> {
    const { bytes, ...rest } = input;
    return await this.createFromStream({ ...rest, stream: Readable.from([bytes]) });
  }

  /**
   * Validates, stores the bytes and records the row. Does not ingest: the caller publishes
   * `attachment.ingest` after this returns, so the row exists before any job can look for it.
   *
   * The body is a stream and stays one (P11, D-160). Its size is capped before the first byte is
   * read, at the smallest of the tenant's file limit and what is left of the interview's and the
   * organization's quotas, and it passes through {@link UploadInspector}, which refuses content
   * that is not the declared type. A refused upload leaves no object and no row.
   */
  async createFromStream(input: CreateAttachmentStreamInput): Promise<AttachmentView> {
    const { db, storage, settings } = this.deps;
    const chain = [{ scope: "tenant" as const, scopeId: input.companyId }];

    const session = await db.session.findFirst({
      where: { id: input.sessionId, companyId: input.companyId },
      select: { id: true, status: true },
    });
    if (!session) throw new AttachmentRejected("session", "Session not found");
    if (session.status === "completed" || session.status === "deleted") {
      throw new AttachmentRejected("session", "This interview is finished");
    }

    const kind = kindForMime(input.mime);
    if (!kind) throw new AttachmentRejected("type", "That file type is not accepted");

    if (kind === "audio") {
      // The tenant's flag ANDed with the template's `voice.enabled` (D-186).
      const enabled = await voiceAllowedForSession(db, settings, {
        companyId: input.companyId,
        sessionId: input.sessionId,
        mode: "recorded",
      });
      if (!enabled) throw new AttachmentRejected("disabled", "Voice answers are turned off");
    } else {
      const enabled = await settings.get("features.fileUpload", chain);
      if (!enabled) throw new AttachmentRejected("disabled", "File attachments are turned off");
      const allowed = await settings.get("files.allowedTypes", chain);
      if (!allowed.includes(input.mime)) {
        throw new AttachmentRejected("type", "That file type is not accepted");
      }
    }

    const perFile = (await settings.get("files.maxSizeMb", chain)) * MB;
    const quotas = await this.quotaRoom(input.companyId, input.sessionId);
    const perFileLabel = `That file is larger than ${perFile / MB} MB`;
    if (quotas.count >= quotas.maxCount) {
      throw new AttachmentRejected("count", `An interview can hold ${quotas.maxCount} attachments`);
    }
    if (quotas.sessionRoom <= 0) {
      throw new AttachmentRejected("quota", "This interview's attachments have reached their size limit");
    }
    if (quotas.tenantRoom <= 0) {
      throw new AttachmentRejected("quota", "This organization's attachment storage is full");
    }
    // The operator's ceiling is the platform's promise and sits above the tenant's own quota
    // setting: it refuses with the tenant told once, and caps this upload to what is left of it.
    const ceilings = this.deps.ceilings;
    const ceiling = await ceilings?.standing(input.companyId, "storageBytes");
    const ceilingRoom = ceiling && ceiling.max > 0 ? ceiling.max - ceiling.used : undefined;
    if (ceilings && ceiling && ceilingRoom !== undefined && ceilingRoom <= 0)
      throw await ceilings.reached(input.companyId, "storageBytes", ceiling.used, ceiling.max);
    const maxBytes = Math.min(perFile, quotas.sessionRoom, quotas.tenantRoom, ceilingRoom ?? Infinity);
    const overflow: Error =
      maxBytes === perFile
        ? new AttachmentRejected("size", perFileLabel)
        : maxBytes === quotas.sessionRoom
          ? new AttachmentRejected("quota", "This interview's attachments have reached their size limit")
          : maxBytes === quotas.tenantRoom
            ? new AttachmentRejected("quota", "This organization's attachment storage is full")
            : new CeilingReachedError("storageBytes", ceiling?.used ?? 0, ceiling?.max ?? 0);

    const filename = safeFilename(input.filename);
    // The row is created first so the id can name the object. A failure to store then leaves a
    // row with no bytes, which is removed below; the reverse would leave bytes no row knows
    // about, which nothing would ever clean up. Created with size 0 so that a concurrent upload
    // already counts toward the interview's attachment total.
    const row = await db.attachment.create({
      data: {
        companyId: input.companyId,
        sessionId: input.sessionId,
        kind,
        filename,
        mime: input.mime,
        sizeBytes: 0,
        storageKey: "",
        status: "pending",
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      },
    });

    const key = attachmentKey(input.companyId, input.sessionId, row.id);
    let sizeBytes: number;
    try {
      const inspected = pipeline(input.stream, new UploadInspector(input.mime), () => undefined);
      const stored = await storage.put(key, inspected, { contentType: input.mime, maxBytes });
      sizeBytes = stored.sizeBytes;
    } catch (err) {
      await db.attachment.delete({ where: { id: row.id } }).catch(() => undefined);
      if (
        (err instanceof ObjectTooLarge || isRequestTooLarge(err)) &&
        overflow instanceof CeilingReachedError
      ) {
        // The operator's ceiling was what stopped it: the tenant and the operator are told once.
        throw (
          (await this.deps.ceilings?.reached(
            input.companyId,
            "storageBytes",
            overflow.current,
            overflow.max,
          )) ?? overflow
        );
      }
      if (err instanceof ObjectTooLarge) throw overflow;
      if (err instanceof IngestRejected) throw new AttachmentRejected("type", err.message);
      // A sender that disconnects mid-upload and multipart's own size limit both end up here.
      if (isRequestTooLarge(err)) throw overflow;
      throw err;
    }

    // Photos lose their metadata (GPS position, device, time) before anything else can read them,
    // and the original is never kept: the stored copy is replaced here, at upload, rather than in
    // the ingest job, where a failure or a job that never ran left the original downloadable.
    if (kind === "image" && (input.mime === "image/png" || input.mime === "image/jpeg")) {
      try {
        const clean = await sanitizeImage(await readAll(await storage.get(key)), input.mime);
        await storage.put(key, clean, { contentType: input.mime });
        sizeBytes = clean.byteLength;
      } catch {
        await this.discard(row.id, key);
        throw new AttachmentRejected("type", "That image could not be read");
      }
    }

    const stored = await db.attachment.update({
      where: { id: row.id },
      data: { storageKey: key, sizeBytes },
    });

    // Two uploads can both pass the room check above. The totals are re-read with this row in
    // them, and whichever one tips over the line is the one that is refused.
    const after = await this.quotaRoom(input.companyId, input.sessionId);
    if (after.count > after.maxCount) {
      await this.discard(row.id, key);
      throw new AttachmentRejected("count", `An interview can hold ${after.maxCount} attachments`);
    }
    if (after.sessionRoom < 0 || after.tenantRoom < 0) {
      await this.discard(row.id, key);
      throw after.sessionRoom < 0
        ? new AttachmentRejected("quota", "This interview's attachments have reached their size limit")
        : new AttachmentRejected("quota", "This organization's attachment storage is full");
    }
    // Two uploads that each fit when they began may not both fit now; the ceiling is re-read
    // after the write, like the quotas above, and the one that crossed it is removed.
    if (ceilings && ceiling && ceiling.max > 0) {
      const now = await ceilings.standing(input.companyId, "storageBytes");
      if (now.used > now.max) {
        await this.discard(row.id, key);
        throw await ceilings.reached(input.companyId, "storageBytes", now.used, now.max);
      }
    }
    await this.deps.ceilings?.afterChange(input.companyId);
    return view(stored);
  }

  /** How much of each quota is left, and how many attachments the interview already holds. */
  private async quotaRoom(
    companyId: string,
    sessionId: string,
  ): Promise<{ count: number; maxCount: number; sessionRoom: number; tenantRoom: number }> {
    const { db, settings } = this.deps;
    const chain = [{ scope: "tenant" as const, scopeId: companyId }];
    const [maxCount, maxSessionMb, tenantMb, session, tenant] = await Promise.all([
      settings.get("files.maxPerSession", chain),
      settings.get("files.maxSessionMb", chain),
      settings.get("files.tenantQuotaMb", chain),
      db.attachment.aggregate({
        where: { companyId, sessionId },
        _sum: { sizeBytes: true },
        _count: { _all: true },
      }),
      db.attachment.aggregate({ where: { companyId }, _sum: { sizeBytes: true } }),
    ]);
    return {
      count: session._count._all,
      maxCount,
      sessionRoom: maxSessionMb * MB - (session._sum.sizeBytes ?? 0),
      tenantRoom: tenantMb * MB - (tenant._sum.sizeBytes ?? 0),
    };
  }

  private async discard(id: string, key: string): Promise<void> {
    await this.deps.db.attachment.delete({ where: { id } }).catch(() => undefined);
    await this.deps.storage.delete(key).catch(() => undefined);
  }

  /** Limits for reading one file, from the catalog. */
  async ingestLimits(companyId: string): Promise<IngestLimits> {
    const chain = [{ scope: "tenant" as const, scopeId: companyId }];
    const { settings } = this.deps;
    const [chars, pages, ratio, cells, entries, mb] = await Promise.all([
      settings.get("files.maxExtractedChars", chain),
      settings.get("files.maxPdfPages", chain),
      settings.get("files.maxZipRatio", chain),
      settings.get("files.maxSheetCells", chain),
      settings.get("files.maxZipEntries", chain),
      settings.get("files.maxUncompressedMb", chain),
    ]);
    return {
      ...DEFAULT_INGEST_LIMITS,
      maxExtractedChars: chars,
      maxPdfPages: pages,
      maxZipRatio: ratio,
      maxSheetCells: cells,
      maxZipEntries: entries,
      maxUncompressedBytes: mb * MB,
    };
  }

  /**
   * Reads the file and records what was found. Idempotent by status: an attachment already `ready`
   * is left alone, so a retried job does not pay for a second summary.
   */
  async ingest(companyId: string, attachmentId: string): Promise<void> {
    const { db, storage, caller, prompts, log } = this.deps;
    if (!caller || !prompts) throw new Error("AttachmentService.ingest needs a caller and prompts");

    const row = await db.attachment.findFirst({
      where: { id: attachmentId, companyId },
      select: {
        id: true,
        sessionId: true,
        mime: true,
        filename: true,
        storageKey: true,
        status: true,
        kind: true,
      },
    });
    if (!row) return;
    if (row.status === "ready") return;

    try {
      if (row.kind === "audio") {
        // Audio is transcribed on the turn path, not here: the transcript has to become the
        // participant's answer straight away, and a job would arrive after the interview moved on.
        await db.attachment.update({
          where: { id: row.id },
          data: { status: "ready", ingestedAt: this.now() },
        });
        return;
      }

      // Images were cleaned of their metadata when they were uploaded (see `createFromStream`).
      const bytes = await readAll(await storage.get(row.storageKey));
      const language = await this.languageFor(row.sessionId);
      const limits = await this.ingestLimits(companyId);
      const result = await ingestAttachment(
        { caller, prompts, logger: log, extractor: extractIsolated, limits },
        { companyId, sessionId: row.sessionId, ref: { type: "attachment", id: row.id } },
        {
          bytes,
          mime: row.mime,
          filename: row.filename,
          ...(language === undefined ? {} : { language }),
        },
      );

      if (result.empty) {
        await db.attachment.update({
          where: { id: row.id },
          data: {
            status: "failed",
            error: "no_text",
            ingestedAt: this.now(),
          },
        });
        return;
      }

      // Chunks and the parent row move together: a summary that claims the file was read, beside
      // chunks from a previous attempt, would make recall quietly wrong.
      await tenantTransaction(db, async (tx) => {
        await tx.attachmentChunk.deleteMany({ where: { attachmentId: row.id } });
        await tx.attachmentChunk.createMany({
          data: result.chunks.map((text, i) => ({
            companyId,
            attachmentId: row.id,
            seq: i + 1,
            text,
          })),
        });
        await tx.attachment.update({
          where: { id: row.id },
          data: {
            status: "ready",
            error: null,
            extractedText: result.text.slice(0, 200_000),
            summary: result.summary,
            ingestedAt: this.now(),
          },
        });
      });

      if (result.vectors) await this.storeVectors(companyId, row.id, result.vectors);
      log.info?.("attachment ingested", {
        companyId,
        attachmentId: row.id,
        chunks: result.chunks.length,
        embedded: result.vectors !== undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("attachment ingestion failed", {
        companyId,
        attachmentId: row.id,
        error: message,
        ...(err instanceof IngestRejected ? { code: err.code } : {}),
      });
      // A code, never the exception's text: the participant sees this, translated (a provider's
      // error or an internal path is not theirs to read). The detail is in the log above.
      await db.attachment.update({
        where: { id: row.id },
        data: {
          status: "failed",
          error: err instanceof IngestRejected ? err.code : "ingest_failed",
          ingestedAt: this.now(),
        },
      });
    }
  }

  /**
   * Writes chunk vectors.
   *
   * Raw SQL because `vector` is not a Prisma type: the column is `Unsupported("vector(1536)")`, so
   * the generated client can neither read nor write it. A vector of the wrong width is dropped
   * rather than written — the column is fixed at 1536, and a provider returning 3072 would fail
   * every row in the statement and lose the chunks along with them.
   */
  private async storeVectors(companyId: string, attachmentId: string, vectors: number[][]): Promise<void> {
    const { db, log } = this.deps;
    const wrong = vectors.find((v) => v.length !== 1536);
    if (wrong) {
      log.warn("embedding width does not fit the column; chunks stay lexical", {
        companyId,
        attachmentId,
        width: wrong.length,
        expected: 1536,
      });
      return;
    }
    for (const [i, vector] of vectors.entries()) {
      await db.$executeRawUnsafe(
        `UPDATE "AttachmentChunk" SET embedding = $1::vector
          WHERE "attachmentId" = $2 AND seq = $3 AND "companyId" = $4`,
        `[${vector.join(",")}]`,
        attachmentId,
        i + 1,
        companyId,
      );
    }
  }

  /** What the participant sees for this session. */
  async list(companyId: string, sessionId: string): Promise<AttachmentView[]> {
    const rows = await this.deps.db.attachment.findMany({
      where: { companyId, sessionId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(view);
  }

  /** The bytes, for playback or download. Returns null when the attachment is not this tenant's. */
  async open(
    companyId: string,
    sessionId: string,
    attachmentId: string,
  ): Promise<{ stream: NodeJS.ReadableStream; mime: string; filename: string } | null> {
    const row = await this.deps.db.attachment.findFirst({
      where: { id: attachmentId, companyId, sessionId },
      select: { storageKey: true, mime: true, filename: true },
    });
    if (!row || row.storageKey.length === 0) return null;
    return {
      stream: await this.deps.storage.get(row.storageKey),
      mime: row.mime,
      filename: row.filename,
    };
  }

  /** Removes one attachment, its chunks and its bytes. */
  async remove(companyId: string, sessionId: string, attachmentId: string): Promise<boolean> {
    const { db, storage, log } = this.deps;
    const row = await db.attachment.findFirst({
      where: { id: attachmentId, companyId, sessionId },
      select: { id: true, storageKey: true },
    });
    if (!row) return false;
    await db.attachment.delete({ where: { id: row.id } });
    if (row.storageKey.length > 0) {
      // Rows first: an orphaned object is recoverable, an Attachment row pointing at bytes that
      // are gone is a broken player and a confusing error.
      await storage.delete(row.storageKey).catch((err: unknown) => {
        log.warn("deleted an attachment row but not its bytes", {
          companyId,
          attachmentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return true;
  }

  /** The interview's language, so a summary comes back in it. */
  /** The interview's language, from its template: what documents are summarized in and speech is expected in. */
  async languageFor(sessionId: string): Promise<string | undefined> {
    const row = await this.deps.db.session.findUnique({
      where: { id: sessionId },
      select: { template: { select: { language: true } } },
    });
    return row?.template?.language ?? undefined;
  }
}

function view(row: {
  id: string;
  kind: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  status: string;
  summary: string | null;
  error: string | null;
  durationMs: number | null;
  messageId?: string | null;
  createdAt: Date;
}): AttachmentView {
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    status: row.status,
    summary: row.summary,
    error: row.error,
    durationMs: row.durationMs,
    messageId: row.messageId ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** Guard mirroring AnalysisService.run: this service must never run outside a tenant scope. */
export function assertTenantScope(where: string): void {
  if (currentTenant() === null) {
    throw new Error(`${where} must be called inside a tenant context (withTenant)`);
  }
}

export type { Prisma };
