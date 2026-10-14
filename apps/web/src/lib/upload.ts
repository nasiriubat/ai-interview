import { t } from "@/i18n";
import { isApiError } from "@/lib/api/errors";

/*
 * The rules of an upload that can be decided in the browser (D-343). The server's limits are the
 * authority and are checked again there; checking here only saves a doomed upload and lets the
 * message say which file and why. The limits are inputs, taken from what the API reports
 * (`GET /p/session` capabilities, `files.*` settings), never constants of this file.
 */

export type RefusalReason = "too_large" | "type" | "empty" | "too_many";

export interface UploadRules {
  /** Media types (`application/pdf`, `image/*`) and extensions (`.csv`). Empty accepts anything. */
  accept: readonly string[];
  maxBytes: number;
}

/** Does `file` match one entry of an accept list? Media type first, extension second (a `.md` often has no type). */
export function matchesAccept(file: Pick<File, "name" | "type">, accept: readonly string[]): boolean {
  if (accept.length === 0) return true;
  const mime = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  const name = file.name.toLowerCase();
  return accept.some((entry) => {
    const a = entry.trim().toLowerCase();
    if (a.startsWith(".")) return name.endsWith(a);
    if (a.endsWith("/*")) return mime.startsWith(a.slice(0, -1));
    return mime !== "" && mime === a;
  });
}

/** Why a file is refused before upload, or null when it may go. */
export function refusalFor(
  file: Pick<File, "name" | "type" | "size">,
  rules: UploadRules,
): RefusalReason | null {
  if (file.size === 0) return "empty";
  if (!matchesAccept(file, rules.accept)) return "type";
  if (file.size > rules.maxBytes) return "too_large";
  return null;
}

export function refusalMessage(reason: RefusalReason, maxMb: number, maxFiles?: number): string {
  const u = t.kit.upload;
  switch (reason) {
    case "too_large":
      return u.tooLarge(maxMb);
    case "type":
      return u.typeRefused;
    case "empty":
      return u.empty;
    case "too_many":
      return u.tooMany(maxFiles ?? 1);
  }
}

/** The server's own refusals, said for the person: 413, 507 and the type check all arrive as codes. */
export function uploadErrorMessage(e: unknown, maxMb: number): string {
  const u = t.kit.upload;
  if (isApiError(e)) {
    if (e.code === "too_large" || e.status === 413) return u.tooLarge(maxMb);
    if (e.code === "storage_full" || e.status === 507) return u.storageFull;
    if (e.code === "forbidden" || e.status === 403) return u.forbidden;
    if (e.code === "validation" || e.status === 415 || e.status === 422) return u.typeRefused;
    if (e.code === "network_error" || e.status === 0) return u.network;
  }
  return u.generic;
}

/** A readable list of what is accepted, from an accept list: `PDF, DOCX, PNG`. */
export function describeAccept(accept: readonly string[]): string {
  const names = new Set<string>();
  const KNOWN: Record<string, string> = {
    "application/pdf": "PDF",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
    "text/markdown": "MD",
    "text/plain": "TXT",
    "text/csv": "CSV",
    "image/png": "PNG",
    "image/jpeg": "JPG",
  };
  for (const entry of accept) {
    const a = entry.trim();
    if (a.startsWith(".")) names.add(a.slice(1).toUpperCase());
    else if (a.endsWith("/*")) names.add(a.slice(0, -2).toUpperCase());
    else names.add(KNOWN[a.toLowerCase()] ?? (a.split("/")[1] ?? a).toUpperCase());
  }
  return [...names].join(", ");
}

export type UploadStatus = "waiting" | "uploading" | "done" | "failed" | "cancelled";

export interface UploadItem<R = unknown> {
  id: string;
  file: File;
  status: UploadStatus;
  /** 0 to 100; meaningful while `uploading`. */
  progress: number;
  error?: string;
  result?: R;
}

/** Counts for the live summary: "2 of 3 uploaded". */
export function summarize(items: readonly UploadItem[]): { done: number; total: number; active: number } {
  return {
    done: items.filter((i) => i.status === "done").length,
    total: items.length,
    active: items.filter((i) => i.status === "uploading" || i.status === "waiting").length,
  };
}
