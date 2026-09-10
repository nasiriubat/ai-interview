import { cache } from "react";
import { en, type Strings } from "./en";
import { fi } from "./fi";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./locale";

/*
 * `t` is a deep proxy over the English shape: every leaf (string or function) resolves
 * against the active locale at the moment it is read, so components keep importing `t`
 * and even module-scope shortcuts such as `const s = t.admin.campaigns` stay correct.
 *
 * Where the active locale lives:
 * - Server components: a per-request React `cache` store filled by the root layout
 *   (`setRequestLocale`). Outside a request the store is uncached and `en` applies.
 * - Client components: a module variable seeded from `<html lang>` in the browser and
 *   set by `LocaleProvider` during render (also during SSR of client components).
 */

export const DICTIONARIES: Record<Locale, Strings> = { en, fi };

const requestStore = cache((): { locale: Locale | null } => ({ locale: null }));

let clientLocale: Locale | null =
  typeof document !== "undefined" && isLocale(document.documentElement.lang)
    ? document.documentElement.lang
    : null;

export function currentLocale(): Locale {
  if (clientLocale) return clientLocale;
  try {
    const l = requestStore().locale;
    if (l) return l;
  } catch {
    // Outside a React request scope: fall through to the default.
  }
  return DEFAULT_LOCALE;
}

/** Called by the root layout (server) once the request's locale is known. */
export function setRequestLocale(locale: Locale): void {
  try {
    requestStore().locale = locale;
  } catch {
    // Not in a request scope; nothing to store.
  }
}

/** Called by `LocaleProvider` (client) so browser-side strings follow the server's choice. */
export function setClientLocale(locale: Locale): void {
  clientLocale = locale;
}

function lookup(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

const proxies = new Map<string, object>();

function proxyFor(path: readonly string[], shape: object): object {
  const id = path.join(".");
  const existing = proxies.get(id);
  if (existing) return existing;
  const proxy = new Proxy(shape, {
    get(target, prop): unknown {
      if (typeof prop !== "string") return Reflect.get(target, prop) as unknown;
      const shapeValue: unknown = Reflect.get(target, prop);
      if (shapeValue === undefined) return undefined;
      const next = [...path, prop];
      if (shapeValue !== null && typeof shapeValue === "object") return proxyFor(next, shapeValue);
      const localized = lookup(DICTIONARIES[currentLocale()], next);
      return localized ?? shapeValue;
    },
  });
  proxies.set(id, proxy);
  return proxy;
}

/** The active language's strings. Components only ever import this. */
export const t: Strings = proxyFor([], en) as Strings;

/** Strings for one explicit locale (server helpers such as `generateMetadata`). */
export function stringsFor(locale: Locale): Strings {
  return DICTIONARIES[locale];
}

export type { Strings };
export { DEFAULT_LOCALE, isLocale, LANG_COOKIE, LOCALES, type Locale } from "./locale";
