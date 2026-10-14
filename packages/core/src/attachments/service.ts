import { ingestAttachment, kindForMime, type Logger, type ModelCaller, type PromptSource } from "@aidp/ai";
import { currentTenant, tenantTransaction } from "@aidp/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { voiceAllowedForSession } from "../settings/features.js";
import type { SettingsService } from "../settings/service.js";
import { attachmentKey, ObjectTooLarge, type StoragePort } from "../storage/index.js";

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
  createdAt: string;
}

/** Thrown when an upload is refused. The message is shown to the participant, so it is plain. */
export class AttachmentRejected extends Error {
  constructor(
    readonly reason: "type" | "size" | "disabled" | "session",
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

export class AttachmentService {
  private readonly now: () => Date;
  constructor(private readonly deps: AttachmentServiceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  /**
   * Validates, stores the bytes and records the row. Does not ingest: the caller publishes
   * `attachment.ingest` after this returns, so the row exists before any job can look for it.
   */
  async create(input: CreateAttachmentInput): Promise<AttachmentView> {
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

    const maxBytes = (await settings.get("files.maxSizeMb", chain)) * 1024 * 1024;
    if (input.bytes.byteLength > maxBytes) {
      throw new AttachmentRejected("size", `That file is larger than ${maxBytes / 1024 / 1024} MB`);
    }

    const filename = safeFilename(input.filename);
    // The row is created first so the id can name the object. A failure to store then leaves a
    // row with no bytes, which ingestion marks failed; the reverse would leave bytes no row knows
    // about, which nothing would ever clean up.
    const row = await db.attachment.create({
      data: {
        companyId: input.companyId,
        sessionId: input.sessionId,
        kind,
        filename,
        mime: input.mime,
        sizeBytes: input.bytes.byteLength,
        storageKey: "",
        status: "pending",
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      },
    });

    const key = attachmentKey(input.companyId, input.sessionId, row.id);
    try {
      await storage.put(key, input.bytes, { contentType: input.mime, maxBytes });
    } catch (err) {
      await db.attachment.delete({ where: { id: row.id } }).catch(() => undefined);
      if (err instanceof ObjectTooLarge) {
        throw new AttachmentRejected("size", `That file is larger than ${maxBytes / 1024 / 1024} MB`);
      }
      throw err;
    }

    const stored = await db.attachment.update({ where: { id: row.id }, data: { storageKey: key } });
    return view(stored);
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

      const bytes = await readAll(await storage.get(row.storageKey));
      const language = await this.languageFor(row.sessionId);
      const result = await ingestAttachment(
        { caller, prompts, logger: log },
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
      log.warn("attachment ingestion failed", { companyId, attachmentId: row.id, error: message });
      await db.attachment.update({
        where: { id: row.id },
        data: { status: "failed", error: message.slice(0, 500), ingestedAt: this.now() },
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
