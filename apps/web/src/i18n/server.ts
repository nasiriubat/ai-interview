import "server-only";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import type { Strings } from "./en";
import { LANG_COOKIE, resolveLocale, type Locale } from "./locale";
import { setRequestLocale, stringsFor } from "./index";

/** Resolves the request's locale from the `lang` cookie or `Accept-Language`, once per request. */
export const requestLocale = cache(async (): Promise<Locale> => {
  const [jar, h] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale({
    cookie: jar.get(LANG_COOKIE)?.value,
    acceptLanguage: h.get("accept-language"),
  });
  setRequestLocale(locale);
  return locale;
});

/** Strings for the request's locale, for `generateMetadata` and other server helpers. */
export async function getStrings(): Promise<Strings> {
  return stringsFor(await requestLocale());
}
