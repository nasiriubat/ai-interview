/**
 * CSV for the sessions export (`GET /campaigns/:id/sessions.csv`).
 *
 * Spreadsheets run a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return as a
 * formula, and a participant's name or email is text a stranger typed. So such a cell is written
 * with a leading apostrophe, which Excel and Sheets show as plain text (OWASP "CSV injection").
 */
/** Written as a code point so the file holds no invisible character. */
const BOM = String.fromCharCode(0xfeff);
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : String(value);
  if (typeof value === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 lines joined with CRLF, with a byte-order mark so a spreadsheet reads UTF-8. */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(","));
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

/** A file name from a campaign name: ASCII letters, digits and dashes, never empty. */
export function csvFileName(campaignName: string, suffix: string): string {
  const slug = campaignName
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug === "" ? "campaign" : slug}-${suffix}.csv`;
}
