"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { LANG_COOKIE, LANG_COOKIE_MAX_AGE, type Locale } from "@/i18n/locale";
import { useLocale } from "@/i18n/LocaleProvider";

/**
 * The language choice, shared by the plain `LanguageSwitch` and the account menu: writes the `lang`
 * cookie and refreshes the server tree, so every component re-renders in the new locale. `shown`
 * follows the choice at once, before the refresh has come back.
 */
export function useLocaleSwitch(): {
  locale: Locale;
  shown: Locale;
  pending: boolean;
  change: (next: Locale) => void;
} {
  const router = useRouter();
  const locale = useLocale();
  const [pending, startTransition] = React.useTransition();
  const [optimistic, setOptimistic] = React.useState<Locale | null>(null);
  const shown = optimistic ?? locale;

  React.useEffect(() => {
    setOptimistic(null);
  }, [locale]);

  const change = React.useCallback(
    (next: Locale): void => {
      if (next === shown) return;
      document.cookie = `${LANG_COOKIE}=${next}; path=/; max-age=${LANG_COOKIE_MAX_AGE}; samesite=lax`;
      setOptimistic(next);
      startTransition(() => {
        router.refresh();
      });
    },
    [router, shown],
  );

  return { locale, shown, pending, change };
}
