import { secretSettingKeys } from "@aidp/shared";
import type { PrismaClient } from "@prisma/client";
import type { Crypto, CryptoPurpose } from "../crypto.js";

/**
 * Moving stored secrets to the active key (P9, D-164).
 *
 * `ENCRYPTED_COLUMNS` is the inventory of every column that holds platform-key ciphertext and the
 * purpose each is sealed for. The rekey job and the status report both walk it, and a database
 * test scans every text and JSON column for the ciphertext shape and fails when one is missing
 * from the list, so a new encrypted column cannot be forgotten.
 */
export interface EncryptedColumn {
  table: "Provider" | "Setting";
  column: string;
  purpose: CryptoPurpose;
  /** What the column holds, for the operator report. */
  label: string;
}

export const ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  { table: "Provider", column: "apiKeyEnc", purpose: "provider.apiKey", label: "Provider API keys" },
  { table: "Provider", column: "headersEnc", purpose: "provider.headers", label: "Provider custom headers" },
  { table: "Setting", column: "value", purpose: "setting.secret", label: "Secret settings (SMTP, tokens)" },
  { table: "Setting", column: "value", purpose: "campaign.linkToken", label: "Campaign link tokens" },
];

/**
 * Ciphertext columns that are deliberately not re-keyed, and why. A scan finding the ciphertext
 * shape in a column not in either list fails the inventory test.
 */
export const NOT_REKEYABLE: readonly { table: string; column: string; reason: string }[] = [
  {
    table: "CampaignEmailHash",
    column: "resumeSeal",
    reason:
      "Sealed under a key derived from the returning person's address or invitation token. Without that secret it cannot be opened, so it is brought under the active key when the person returns.",
  },
];

const BATCH = 200;

const LINK_TOKEN_KEY = "_linkToken";

export interface KeyUsage {
  /** The active key id, then each previous one the ring can read. */
  ring: { id: string; active: boolean }[];
  /** Stored values per column and key id; `v1` is the legacy format, `unreadable` has no key in the ring. */
  columns: { table: string; column: string; purpose: string; label: string; byKey: Record<string, number> }[];
  /** Total stored values not under the active key: what the rekey job still has to move. */
  pending: number;
  /** True when no stored value needs a previous key (or v1): the previous key can be removed. */
  previousKeysRemovable: boolean;
}

export interface RekeyResult {
  scanned: number;
  rekeyed: number;
  alreadyCurrent: number;
  /** Rows changed by someone else between read and write: left for the next run. */
  conflicts: number;
  /** Rows whose ciphertext no key in the ring opens. Never overwritten. */
  unreadable: number;
}

interface Cell {
  id: string;
  token: string;
  column: EncryptedColumn;
}

/** Streams every ciphertext in the inventory, by id cursor, in batches. */
async function* cells(db: PrismaClient): AsyncGenerator<Cell> {
  for (const column of ENCRYPTED_COLUMNS) {
    if (column.table === "Provider") {
      let after: string | undefined;
      for (;;) {
        const rows = await db.provider.findMany({
          where: { [column.column]: { not: "" } },
          select: { id: true, apiKeyEnc: true, headersEnc: true },
          orderBy: { id: "asc" },
          take: BATCH,
          ...(after ? { cursor: { id: after }, skip: 1 } : {}),
        });
        for (const r of rows) {
          const token = column.column === "apiKeyEnc" ? r.apiKeyEnc : r.headersEnc;
          if (token !== "") yield { id: r.id, token, column };
        }
        if (rows.length < BATCH) break;
        after = rows[rows.length - 1]?.id;
      }
    } else {
      const keys =
        column.purpose === "campaign.linkToken" ? [LINK_TOKEN_KEY] : (secretSettingKeys() as string[]);
      let after: string | undefined;
      for (;;) {
        const rows = await db.setting.findMany({
          where: { key: { in: keys } },
          select: { id: true, value: true },
          orderBy: { id: "asc" },
          take: BATCH,
          ...(after ? { cursor: { id: after }, skip: 1 } : {}),
        });
        for (const r of rows)
          if (typeof r.value === "string" && r.value !== "") yield { id: r.id, token: r.value, column };
        if (rows.length < BATCH) break;
        after = rows[rows.length - 1]?.id;
      }
    }
  }
}

/** Counts stored secrets by the key that seals them. Reads only. Run in the system tenant context. */
export async function keyUsage(db: PrismaClient, crypto: Crypto): Promise<KeyUsage> {
  const byColumn = new Map<EncryptedColumn, Record<string, number>>();
  for (const c of ENCRYPTED_COLUMNS) byColumn.set(c, {});
  let pending = 0;
  let needsPrevious = false;
  for await (const cell of cells(db)) {
    const kid = crypto.keyIdOf(cell.token);
    const label = kid !== null && (kid === "v1" || crypto.keyIds.includes(kid)) ? kid : (kid ?? "unreadable");
    const counts = byColumn.get(cell.column) ?? {};
    byColumn.set(cell.column, counts);
    counts[label] = (counts[label] ?? 0) + 1;
    if (!crypto.isCurrent(cell.token)) {
      pending++;
      needsPrevious = true;
    }
  }
  return {
    ring: crypto.keyIds.map((id) => ({ id, active: id === crypto.activeKeyId })),
    columns: ENCRYPTED_COLUMNS.map((c) => ({
      table: c.table,
      column: c.column,
      purpose: c.purpose,
      label: c.label,
      byKey: byColumn.get(c) ?? {},
    })),
    pending,
    previousKeysRemovable: !needsPrevious,
  };
}

/**
 * Re-encrypts every stored secret under the active key, one compare-and-swap per row. A row
 * someone edited in the meantime keeps their value (the swap finds a different ciphertext and
 * does nothing), and a second run finishes what a crashed first one began: idempotent by
 * construction. Run in the system tenant context.
 */
export async function rekeyAll(
  db: PrismaClient,
  crypto: Crypto,
  /** A test seam: runs between reading a value and swapping it, where a concurrent edit would land. */
  hooks: { beforeSwap?: (cell: { table: string; id: string }) => Promise<void> } = {},
): Promise<RekeyResult> {
  const result: RekeyResult = { scanned: 0, rekeyed: 0, alreadyCurrent: 0, conflicts: 0, unreadable: 0 };
  for await (const cell of cells(db)) {
    result.scanned++;
    if (crypto.isCurrent(cell.token)) {
      result.alreadyCurrent++;
      continue;
    }
    let next: string;
    try {
      next = crypto.encrypt(crypto.decrypt(cell.token, cell.column.purpose), cell.column.purpose);
    } catch {
      result.unreadable++;
      continue;
    }
    await hooks.beforeSwap?.({ table: cell.column.table, id: cell.id });
    const swapped =
      cell.column.table === "Provider"
        ? await db.provider.updateMany({
            where: { id: cell.id, [cell.column.column]: cell.token },
            data: { [cell.column.column]: next },
          })
        : await db.setting.updateMany({
            where: { id: cell.id, value: { equals: cell.token } },
            data: { value: next },
          });
    if (swapped.count === 1) result.rekeyed++;
    else result.conflicts++;
  }
  return result;
}
