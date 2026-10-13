import type { PrismaClient } from "@prisma/client";
import type { Crypto } from "../crypto.js";

/**
 * Custom provider headers at rest (NFR-07, D-147).
 *
 * A header such as a gateway's `x-api-key` is a credential, the same as `apiKey`, and was stored
 * and returned as plain JSON. It is now one encrypted JSON object in `Provider.headersEnc`, opened
 * only where a connection is made. The browser is given names, never values.
 */

/**
 * The value a client sends for a header it does not want to change. The API returns names only, so
 * an edit form cannot send back values it was never given; it sends this for each header it leaves
 * alone, the same convention secret settings use.
 */
export const HEADER_KEEP = "__keep__";

/** The encrypted column value for a header map; empty means "no headers" and stores nothing. */
export function sealHeaders(crypto: Crypto, headers: Record<string, string>): string {
  return Object.keys(headers).length === 0 ? "" : crypto.encrypt(JSON.stringify(headers));
}

/**
 * The headers of a provider row. `legacy` is the plaintext column of rows written before the
 * encrypted one existed; it is read only while a row has not been through the backfill.
 */
export function openHeaders(crypto: Crypto, headersEnc: string, legacy: unknown): Record<string, string> {
  if (headersEnc !== "") {
    const parsed: unknown = JSON.parse(crypto.decrypt(headersEnc));
    return stringRecord(parsed);
  }
  return stringRecord(legacy);
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  return out;
}

/**
 * Encrypts the headers of every provider still holding them in plaintext, and empties the old
 * column. Idempotent: a row that has been through it has nothing left to do. Run by the bootstrap
 * (the migrate step of every deploy), because the key lives in the application and not in SQL.
 * The old column is dropped in a later migration, once no build reads it.
 */
export async function encryptLegacyProviderHeaders(db: PrismaClient, crypto: Crypto): Promise<number> {
  const rows = await db.provider.findMany({
    where: { headersEnc: "", NOT: { headers: { equals: {} } } },
    select: { id: true, headers: true },
  });
  let done = 0;
  for (const row of rows) {
    const headers = stringRecord(row.headers);
    await db.provider.update({
      where: { id: row.id },
      data: { headersEnc: sealHeaders(crypto, headers), headers: {} },
    });
    if (Object.keys(headers).length > 0) done++;
  }
  return done;
}
