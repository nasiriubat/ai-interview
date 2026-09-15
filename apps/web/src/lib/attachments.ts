/**
 * What the file picker offers and what the browser refuses before uploading (FR-31).
 *
 * The allowed types come from the session's capabilities, which carry the tenant's
 * `files.allowedTypes` as it is actually in force, so widening the setting widens the picker
 * without a web release. The extension table below only makes those media types pickable by
 * name: a type it does not know is still offered and accepted, by media type alone.
 */
const EXTENSIONS: Record<string, readonly string[]> = {
  "application/pdf": [".pdf"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "text/markdown": [".md"],
  "text/plain": [".txt"],
  "text/csv": [".csv"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
};

/** The shipped defaults, used only when an API does not send the session's capabilities. */
export const DEFAULT_ALLOWED_TYPES: readonly string[] = Object.keys(EXTENSIONS);
export const DEFAULT_MAX_SIZE_MB = 20;

/** The `accept` attribute: extensions and media types, because browsers vary on which they honour. */
export function acceptFor(allowedTypes: readonly string[]): string {
  const extensions = allowedTypes.flatMap((mime) => EXTENSIONS[mime] ?? []);
  return [...new Set([...extensions, ...allowedTypes])].join(",");
}

/**
 * Media type first, extension second: a `.md` or `.csv` file often arrives with an empty or
 * invented type, and refusing the participant's own notes over that would be wrong.
 */
export function isAllowedAttachment(file: File, allowedTypes: readonly string[]): boolean {
  const mime = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime !== "" && allowedTypes.includes(mime)) return true;
  const name = file.name.toLowerCase();
  return allowedTypes.some((type) => (EXTENSIONS[type] ?? []).some((ext) => name.endsWith(ext)));
}

/** The limit in force for this session. The API checks again; this only saves a doomed upload. */
export function isTooLarge(file: File, maxSizeMb: number): boolean {
  return file.size > maxSizeMb * 1024 * 1024;
}

/** A file size a person can read. Units are the same in both languages, so this is not translated. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} kB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Elapsed recording time as `m:ss`. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
