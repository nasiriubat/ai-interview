import { pipeline, type Readable } from "node:stream";
import {
  extractIsolated,
  IngestRejected,
  ingestAttachment,
  kindForMime,
  sanitizeImage,
  UploadInspector,
  type Logger,
  type ModelCaller,
  type PromptSource,
} from "@aidp/ai";
import type { PrismaClient } from "@prisma/client";
import type { SettingsService } from "../settings/service.js";
import { ObjectTooLarge, type StoragePort } from "../storage/index.js";
import { AttachmentRejected, safeFilename, type AttachmentService } from "./service.js";

/** The most background documents one campaign holds: context, not an archive. */
export const MAX_CAMPAIGN_DOCUMENTS = 10;

const MB = 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

function segment(value: string): string {
  if (!SEGMENT.test(value)) throw new Error(`Unsafe storage key segment: ${JSON.stringify(value)}`);
  return value;
}

/**
 * Where a campaign's documents live: their own top-level prefix, beside `exports/`, not under the
 * tenant's per-session folders. The storage sweep reclaims every folder under a tenant that is not
 * a live session, so a campaign folder there would be collected as an orphan (by this release's
 * sweep and by any earlier one a rollback runs).
 */
export const campaignDocsPrefix = (companyId: string): string => `campaign-docs/${segment(companyId)}/`;

export function campaignDocumentKey(companyId: string, campaignId: string, documentId: string): string {
  return `${campaignDocsPrefix(companyId)}${segment(campaignId)}/${segment(documentId)}`;
}

export interface CampaignDocumentView {
  id: string;
  kind: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  status: string;
  summary: string | null;
  error: string | null;
  createdAt: string;
}

/** A readable document as the interviewer and the analysis see it. */
export interface CampaignBackground {
  filename: string;
  summary: string;
  text: string;
}

export interface CampaignDocumentDeps {
  db: PrismaClient;
  storage: StoragePort;
  settings: SettingsService;
  attachments: AttachmentService;
  log: Logger;
  caller?: ModelCaller;
  prompts?: PromptSource;
  now?: () => Date;
}

/**
 * The organisation's background documents for a campaign (D-491): an org chart, a process
 * description, the tools already in use. Uploaded by an administrator and read exactly like a
 * participant's file (the same type allowlist, size limit, content check, metadata stripping,
 * sandboxed extraction and fenced summary), and counted against the tenant's storage quota.
 */
export class CampaignDocumentService {
  private readonly now: () => Date;
  constructor(private readonly deps: CampaignDocumentDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  async create(input: {
    companyId: string;
    campaignId: string;
    filename: string;
    mime: string;
    stream: Readable;
    uploadedById?: string;
  }): Promise<CampaignDocumentView> {
    const { db, storage, settings } = this.deps;
    const campaign = await db.campaign.findFirst({
      where: { id: input.campaignId, companyId: input.companyId },
      select: { id: true },
    });
    if (!campaign) throw new AttachmentRejected("session", "Campaign not found");

    const mime = input.mime.split(";")[0]?.trim().toLowerCase() ?? "";
    const kind = kindForMime(mime);
    const chain = [{ scope: "tenant" as const, scopeId: input.companyId }];
    const allowed = await settings.get("files.allowedTypes", chain);
    if (kind === null || kind === "audio" || !allowed.includes(mime))
      throw new AttachmentRejected("type", "That file type is not accepted");

    const count = await db.campaignDocument.count({
      where: { companyId: input.companyId, campaignId: input.campaignId },
    });
    if (count >= MAX_CAMPAIGN_DOCUMENTS)
      throw new AttachmentRejected("count", `A campaign can hold ${MAX_CAMPAIGN_DOCUMENTS} documents`);

    const perFile = (await settings.get("files.maxSizeMb", chain)) * MB;
    const tenantRoom = await this.deps.attachments.tenantRoom(input.companyId);
    if (tenantRoom <= 0)
      throw new AttachmentRejected("quota", "This organization's attachment storage is full");
    const maxBytes = Math.min(perFile, tenantRoom);
    const overflow =
      maxBytes === perFile
        ? new AttachmentRejected("size", `That file is larger than ${perFile / MB} MB`)
        : new AttachmentRejected("quota", "This organization's attachment storage is full");

    const row = await db.campaignDocument.create({
      data: {
        companyId: input.companyId,
        campaignId: input.campaignId,
        filename: safeFilename(input.filename),
        mime,
        kind,
        ...(input.uploadedById ? { uploadedById: input.uploadedById } : {}),
      },
    });
    const key = campaignDocumentKey(input.companyId, input.campaignId, row.id);
    let sizeBytes: number;
    try {
      const inspected = pipeline(input.stream, new UploadInspector(mime), () => undefined);
      sizeBytes = (await storage.put(key, inspected, { contentType: mime, maxBytes })).sizeBytes;
    } catch (err) {
      await db.campaignDocument.delete({ where: { id: row.id } }).catch(() => undefined);
      await storage.delete(key).catch(() => undefined);
      if (err instanceof ObjectTooLarge) throw overflow;
      if (err instanceof IngestRejected) throw new AttachmentRejected("type", err.message);
      if ((err as { code?: string } | null)?.code === "FST_REQ_FILE_TOO_LARGE") throw overflow;
      throw err;
    }
    // A photo loses its metadata before anything reads it, and the original is not kept.
    if (kind === "image" && (mime === "image/png" || mime === "image/jpeg")) {
      try {
        const clean = await sanitizeImage(await readAll(await storage.get(key)), mime);
        await storage.put(key, clean, { contentType: mime });
        sizeBytes = clean.byteLength;
      } catch {
        await db.campaignDocument.delete({ where: { id: row.id } }).catch(() => undefined);
        await storage.delete(key).catch(() => undefined);
        throw new AttachmentRejected("type", "That image could not be read");
      }
    }
    const stored = await db.campaignDocument.update({
      where: { id: row.id },
      data: { storageKey: key, sizeBytes },
    });
    return view(stored);
  }

  async list(companyId: string, campaignId: string): Promise<CampaignDocumentView[]> {
    const rows = await this.deps.db.campaignDocument.findMany({
      where: { companyId, campaignId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(view);
  }

  async remove(companyId: string, campaignId: string, documentId: string): Promise<boolean> {
    const { db, storage } = this.deps;
    const row = await db.campaignDocument.findFirst({ where: { id: documentId, companyId, campaignId } });
    if (!row) return false;
    await db.campaignDocument.delete({ where: { id: row.id } });
    if (row.storageKey) await storage.delete(row.storageKey).catch(() => undefined);
    return true;
  }

  async open(
    companyId: string,
    campaignId: string,
    documentId: string,
  ): Promise<{ mime: string; filename: string; stream: NodeJS.ReadableStream } | null> {
    const row = await this.deps.db.campaignDocument.findFirst({
      where: { id: documentId, companyId, campaignId },
    });
    if (!row?.storageKey) return null;
    return { mime: row.mime, filename: row.filename, stream: await this.deps.storage.get(row.storageKey) };
  }

  /** The readable documents, oldest first, as background for the interviewer and the analysis. */
  async background(companyId: string, campaignId: string): Promise<CampaignBackground[]> {
    const rows = await this.deps.db.campaignDocument.findMany({
      where: { companyId, campaignId, status: "ready" },
      orderBy: { createdAt: "asc" },
      select: { filename: true, summary: true, extractedText: true },
    });
    return rows.map((r) => ({ filename: r.filename, summary: r.summary ?? "", text: r.extractedText ?? "" }));
  }

  /**
   * Reads one document: the same sandboxed extraction and fenced summary as a participant's file.
   * Idempotent by status. Failures store a code, never the exception's text (D-489).
   */
  async ingest(companyId: string, documentId: string): Promise<void> {
    const { db, storage, caller, prompts, log } = this.deps;
    if (!caller || !prompts) throw new Error("CampaignDocumentService.ingest needs a caller and prompts");
    const row = await db.campaignDocument.findFirst({
      where: { id: documentId, companyId },
      include: { campaign: { select: { template: { select: { language: true } } } } },
    });
    if (!row || row.status === "ready" || !row.storageKey) return;
    try {
      const bytes = await readAll(await storage.get(row.storageKey));
      const result = await ingestAttachment(
        {
          caller,
          prompts,
          logger: log,
          extractor: extractIsolated,
          limits: await this.deps.attachments.ingestLimits(companyId),
        },
        { companyId, campaignId: row.campaignId, ref: { type: "campaign_document", id: row.id } },
        {
          bytes,
          mime: row.mime,
          filename: row.filename,
          ...(row.campaign.template.language ? { language: row.campaign.template.language } : {}),
        },
      );
      await db.campaignDocument.update({
        where: { id: row.id },
        data: result.empty
          ? { status: "failed", error: "no_text", ingestedAt: this.now() }
          : {
              status: "ready",
              error: null,
              summary: result.summary,
              extractedText: result.text.slice(0, 200_000),
              ingestedAt: this.now(),
            },
      });
    } catch (err) {
      log.warn("campaign document ingestion failed", {
        companyId,
        documentId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await db.campaignDocument.update({
        where: { id: row.id },
        data: {
          status: "failed",
          error: err instanceof IngestRejected ? err.code : "ingest_failed",
          ingestedAt: this.now(),
        },
      });
    }
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
  createdAt: Date;
}): CampaignDocumentView {
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    status: row.status,
    summary: row.summary,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
