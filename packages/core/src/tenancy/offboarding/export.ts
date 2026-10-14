import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { tenantTransaction, withTenant } from "@aidp/db";
import type { PrismaClient } from "@prisma/client";
import type { Crypto } from "../../crypto.js";
import { ObjectNotFound, type StoragePort } from "../../storage/port.js";
import { ArchiveFormatError, openStream, readKeyId, sealStream } from "./archive-crypto.js";
import { EXPORT_OMIT_COLUMNS, ident, tenantTables } from "./tables.js";
import { streamZip, type StreamEntry } from "./zip-stream.js";

/**
 * A tenant's data, as one signed and encrypted archive (D-225, security plan A5).
 *
 * What goes in: every row of every table that carries the tenant's `companyId` (as JSON lines,
 * sealed secrets and token hashes left out), every uploaded file, and a manifest of what was
 * written with a SHA-256 for each entry. The manifest is signed with a key derived from the
 * platform key; the archive as a whole is sealed under another (segment-wise AES-256-GCM), so the
 * bytes at rest in the object store, and in the backups that copy them, are ciphertext.
 *
 * Where it lives: `exports/<companyId>/<stamp>/archive` and `.../meta`, outside the tenant's own
 * prefix on purpose, so the export outlives the purge that follows it until its own retention.
 *
 * Quiescence: an export is taken of a tenant that was suspended first. It pages through each
 * table rather than holding one long transaction, so on a live tenant it is a consistent-enough
 * copy and not a snapshot; the offboarding flow suspends before it exports for that reason.
 */

const PAGE = 500;
/** An archive bigger than this is refused rather than half-written (the zip writer has no ZIP64). */
export const EXPORT_MAX_UPLOAD_BYTES = 3.5 * 1024 ** 3;

export const exportsPrefix = (companyId: string): string => `exports/${companyId}/`;
const archiveKey = (companyId: string, stamp: string): string => `exports/${companyId}/${stamp}/archive`;
const metaKey = (companyId: string, stamp: string): string => `exports/${companyId}/${stamp}/meta`;

export interface ExportMeta {
  stamp: string;
  companyId: string;
  requestedBy: string;
  createdAt: string;
  /** The key that sealed the archive. */
  keyId: string;
  /** Size and SHA-256 of the sealed bytes as stored. */
  bytes: number;
  sha256: string;
  /** HMAC-SHA256 (hex) of `manifest.json` under the tenant's export signing key. */
  signature: string;
  rows: Record<string, number>;
  files: number;
  skippedFiles: number;
}

export interface TenantExporterDeps {
  db: PrismaClient;
  storage: StoragePort;
  crypto: Crypto;
  now?: () => Date;
  log?: { info: (m: string, meta?: Record<string, unknown>) => void };
}

const SEALED = /^(v1|v2|r1)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/;

function jsonLine(row: Record<string, unknown>): string {
  return `${JSON.stringify(row, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}\n`;
}

export class TenantExporter {
  private readonly now: () => Date;
  constructor(private readonly deps: TenantExporterDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async run(companyId: string, requestedBy: string): Promise<ExportMeta> {
    const { db, storage, crypto } = this.deps;
    const stamp = this.now()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const seal = crypto.bulkKey("export-seal", companyId);
    const signing = crypto.bulkKey("export-sign", companyId);
    if (!seal || !signing) throw new Error("No platform key available to seal the export");

    const rows: Record<string, number> = {};
    const manifest: { path: string; bytes: number; sha256: string; rows?: number }[] = [];
    let files = 0;
    let skippedFiles = 0;
    let uploadBytes = 0;
    let signature = "";

    const tables = (await withTenant(companyId, () => tenantTables(db))).ordered;

    // Records size and digest of one entry as it streams past.
    const tracked = (
      path: string,
      source: AsyncIterable<Uint8Array>,
      rowCounter?: () => number,
    ): AsyncIterable<Uint8Array> => ({
      async *[Symbol.asyncIterator]() {
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of source) {
          hash.update(chunk);
          bytes += chunk.byteLength;
          yield chunk;
        }
        manifest.push({
          path,
          bytes,
          sha256: hash.digest("hex"),
          ...(rowCounter ? { rows: rowCounter() } : {}),
        });
      },
    });

    const tableLines = (table: string): { source: AsyncIterable<Uint8Array>; count: () => number } => {
      let count = 0;
      const omit = new Set(EXPORT_OMIT_COLUMNS[table] ?? []);
      const source: AsyncIterable<Uint8Array> = {
        async *[Symbol.asyncIterator]() {
          for (let offset = 0; ; offset += PAGE) {
            // A transaction that carries the tenant: a raw statement outside one is not paired
            // with the setting row-level security reads, and would see no rows at all.
            const page = await withTenant(companyId, () =>
              tenantTransaction(db, (tx) =>
                tx.$queryRawUnsafe<Record<string, unknown>[]>(
                  `SELECT * FROM ${ident(table)} WHERE "companyId" = $1 ORDER BY ctid LIMIT ${PAGE} OFFSET ${offset}`,
                  companyId,
                ),
              ),
            );
            if (page.length === 0) return;
            let text = "";
            for (const row of page) {
              for (const col of omit) delete row[col];
              if (table === "Setting" && typeof row.value === "string" && SEALED.test(row.value))
                row.value = "[secret omitted]";
              text += jsonLine(row);
              count++;
            }
            yield Buffer.from(text, "utf8");
            if (page.length < PAGE) return;
          }
        },
      };
      return { source, count: () => count };
    };

    const self = this;
    async function* entries(): AsyncGenerator<StreamEntry> {
      yield {
        path: "README.txt",
        data: tracked(
          "README.txt",
          oneChunk(
            [
              "Tenant export",
              "",
              "data/<Table>.jsonl   one JSON object per row, one file per table",
              "uploads/             the files participants attached or recorded, named <attachmentId>-<filename>",
              "manifest.json        every entry with its size and SHA-256",
              "manifest.sig         HMAC-SHA256 of manifest.json (hex), verifiable by the platform operator",
              "",
              "Sealed secrets (provider keys, custom headers) and token hashes are omitted.",
              "",
            ].join("\n"),
          ),
        ),
      };
      for (const table of tables) {
        const { source, count } = tableLines(table);
        const path = `data/${table}.jsonl`;
        yield {
          path,
          data: {
            async *[Symbol.asyncIterator]() {
              yield* tracked(path, source, count);
              rows[table] = count();
            },
          },
        };
      }
      const attachments = await withTenant(companyId, () =>
        db.attachment.findMany({
          where: { companyId },
          select: { id: true, filename: true, storageKey: true, sizeBytes: true },
          orderBy: { createdAt: "asc" },
        }),
      );
      for (const a of attachments) {
        if (uploadBytes + a.sizeBytes > EXPORT_MAX_UPLOAD_BYTES) {
          skippedFiles++;
          continue;
        }
        let stream;
        try {
          stream = await storage.get(a.storageKey);
        } catch (err) {
          if (err instanceof ObjectNotFound) {
            skippedFiles++;
            continue;
          }
          throw err;
        }
        uploadBytes += a.sizeBytes;
        files++;
        const path = `uploads/${a.id}-${a.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80)}`;
        yield { path, data: tracked(path, stream as AsyncIterable<Uint8Array>) };
      }
      const body = Buffer.from(
        JSON.stringify(
          {
            companyId,
            createdAt: self.now().toISOString(),
            requestedBy,
            rows,
            files,
            skippedFiles,
            entries: manifest,
          },
          null,
          2,
        ),
        "utf8",
      );
      signature = createHmac("sha256", signing!.key).update(body).digest("hex");
      yield { path: "manifest.json", data: body };
      yield { path: "manifest.sig", data: `${signature}\n` };
    }

    const sealed = sealStream(streamZip(entries(), this.now()), seal.kid, seal.key);
    const digest = createHash("sha256");
    let bytes = 0;
    const counted = (async function* () {
      for await (const chunk of sealed) {
        digest.update(chunk);
        bytes += chunk.length;
        yield chunk;
      }
    })();
    await storage.put(archiveKey(companyId, stamp), Readable.from(counted), {
      contentType: "application/octet-stream",
    });

    const meta: ExportMeta = {
      stamp,
      companyId,
      requestedBy,
      createdAt: this.now().toISOString(),
      keyId: seal.kid,
      bytes,
      sha256: digest.digest("hex"),
      signature,
      rows,
      files,
      skippedFiles,
    };
    await storage.put(metaKey(companyId, stamp), Buffer.from(JSON.stringify(meta), "utf8"), {
      contentType: "application/json",
    });
    this.deps.log?.info("tenant export written", { companyId, stamp, bytes, files, skippedFiles });
    return meta;
  }

  /** The exports a tenant has, newest first. */
  async list(companyId: string): Promise<ExportMeta[]> {
    const stamps = await this.deps.storage.listPrefixes(`exports/${companyId}`);
    const out: ExportMeta[] = [];
    for (const s of stamps) {
      const meta = await this.readMeta(companyId, s.name);
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => b.stamp.localeCompare(a.stamp));
  }

  async readMeta(companyId: string, stamp: string): Promise<ExportMeta | null> {
    try {
      const stream = await this.deps.storage.get(metaKey(companyId, stamp));
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.from(c as Uint8Array));
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ExportMeta;
    } catch (err) {
      if (err instanceof ObjectNotFound) return null;
      throw err;
    }
  }

  /**
   * The archive as a plain zip, decrypted on the way out. Throws `ArchiveFormatError` if the
   * stored bytes do not authenticate; nothing unauthenticated is released, because each segment
   * is verified before it is yielded.
   */
  async open(companyId: string, stamp: string): Promise<AsyncIterable<Buffer>> {
    const { storage, crypto } = this.deps;
    const raw = await storage.get(archiveKey(companyId, stamp));
    return openStream(
      raw as AsyncIterable<Uint8Array>,
      (kid) => crypto.bulkKey("export-seal", companyId, kid)?.key ?? null,
    );
  }

  /** Whether the meta's signature matches a manifest, for a recipient who holds the platform key. */
  verifySignature(companyId: string, manifestJson: Buffer, signatureHex: string): boolean {
    const signing = this.deps.crypto.bulkKey("export-sign", companyId);
    if (!signing) return false;
    const expect = createHmac("sha256", signing.key).update(manifestJson).digest("hex");
    return expect === signatureHex.trim();
  }
}

async function* oneChunk(text: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(text, "utf8");
}

export { ArchiveFormatError, readKeyId };
