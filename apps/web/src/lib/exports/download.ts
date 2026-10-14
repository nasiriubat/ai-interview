import { apiErrorFromResponse } from "@/lib/api/errors";

/** A file the browser has been handed, and what the server said about it on the way. */
export interface SavedFile {
  filename: string;
  /** Machine-readable notes from `x-export-warnings`, such as `diagram_unrendered:2`. */
  warnings: string[];
  pages: number | null;
}

/** The file name a `Content-Disposition: attachment; filename="x"` header names, or the fallback. */
export function filenameFrom(contentDisposition: string | null, fallback: string): string {
  const quoted = /filename="([^"\\/]+)"/i.exec(contentDisposition ?? "");
  const bare = /filename=([^;\s"\\/]+)/i.exec(contentDisposition ?? "");
  return quoted?.[1] ?? bare?.[1] ?? fallback;
}

function hand(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Fetches a download through the web proxy and saves it. Throws the API's error (an `ApiError`
 * with its code) so a caller can tell "busy" from "too large" from "something broke".
 */
export async function saveFromUrl(url: string, fallbackName: string): Promise<SavedFile> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw await apiErrorFromResponse(res);
  const filename = filenameFrom(res.headers.get("content-disposition"), fallbackName);
  const warnings = (res.headers.get("x-export-warnings") ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
  const pages = Number(res.headers.get("x-export-pages"));
  hand(await res.blob(), filename);
  return { filename, warnings, pages: Number.isFinite(pages) && pages > 0 ? pages : null };
}

/** Saves text the page already holds, such as a report's Markdown. */
export function saveText(content: string, filename: string, mime: string): SavedFile {
  hand(new Blob([content], { type: `${mime};charset=utf-8` }), filename);
  return { filename, warnings: [], pages: null };
}
