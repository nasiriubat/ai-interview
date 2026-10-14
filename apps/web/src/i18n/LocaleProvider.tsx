"use client";

import * as React from "react";
import "@/lib/zod-jitless";
import type { Locale } from "./locale";
import { setClientLocale } from "./index";

const LocaleContext = React.createContext<Locale>("en");

/**
 * Publishes the server-chosen locale to client components. The module variable is set
 * during render (before any child reads `t`), and again after hydration for safety.
 */
export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}): React.JSX.Element {
  setClientLocale(locale);
  React.useEffect(() => {
    setClientLocale(locale);
    document.documentElement.lang = locale;
  }, [locale]);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return React.useContext(LocaleContext);
}
