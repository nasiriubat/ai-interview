/**
 * Locale resolution, kept free of Next.js imports so it can be unit tested and used
 * from both the server (cookies + Accept-Language) and the browser (`<html lang>`).
 */
export const LOCALES = ["en", "fi"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** Cookie written by the language switch; one year, readable by JavaScript on purpose. */
export const LANG_COOKIE = "lang";
export const LANG_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Parses an `Accept-Language` header into language tags ordered by quality, lowercased. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  const entries = header
    .split(",")
    .map((part, index) => {
      const [tagRaw = "", ...params] = part.trim().split(";");
      const tag = tagRaw.trim().toLowerCase();
      let q = 1;
      for (const p of params) {
        const [k, v] = p.trim().split("=");
        if (k === "q" && v !== undefined) {
          const n = Number(v);
          q = Number.isFinite(n) ? n : 0;
        }
      }
      return { tag, q, index };
    })
    .filter((e) => e.tag !== "" && e.q > 0);
  entries.sort((a, b) => b.q - a.q || a.index - b.index);
  return entries.map((e) => e.tag);
}

/**
 * The `lang` cookie wins; otherwise the first supported language in `Accept-Language`
 * (matching on the primary subtag, so `fi-FI` selects `fi`); `en` as the fallback.
 */
export function resolveLocale(input: {
  cookie?: string | null | undefined;
  acceptLanguage?: string | null | undefined;
}): Locale {
  if (isLocale(input.cookie)) return input.cookie;
  for (const tag of parseAcceptLanguage(input.acceptLanguage)) {
    const primary = tag.split("-")[0];
    if (isLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}
