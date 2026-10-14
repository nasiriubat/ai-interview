"use client";

import { LanguagesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { t } from "@/i18n";
import { LANG_COOKIE, LANG_COOKIE_MAX_AGE, LOCALES, type Locale } from "@/i18n/locale";
import { useLocale } from "@/i18n/LocaleProvider";
import { cn } from "@/lib/utils";

/**
 * Writes the `lang` cookie and refreshes the server tree; `LocaleProvider` picks the new
 * locale up from the root layout and every component re-renders with it.
 */
export function LanguageSwitch({
  className,
  id = "language-switch",
}: {
  className?: string;
  /** Distinct when a page shows more than one switch (the landing page: header, menu, footer). */
  id?: string;
}): React.JSX.Element {
  const router = useRouter();
  const locale = useLocale();
  const [pending, startTransition] = React.useTransition();
  const [optimistic, setOptimistic] = React.useState<Locale | null>(null);
  const shown = optimistic ?? locale;

  React.useEffect(() => {
    setOptimistic(null);
  }, [locale]);

  const change = (next: Locale): void => {
    if (next === shown) return;
    document.cookie = `${LANG_COOKIE}=${next}; path=/; max-age=${LANG_COOKIE_MAX_AGE}; samesite=lax`;
    setOptimistic(next);
    startTransition(() => {
      router.refresh();
    });
  };

  return (
    <div className={cn("flex items-center gap-1 print:hidden", className)}>
      <LanguagesIcon className="text-muted-foreground hidden size-4 sm:block" aria-hidden="true" />
      <label className="sr-only" htmlFor={id}>
        {t.app.language}
      </label>
      <select
        id={id}
        value={shown}
        disabled={pending}
        aria-busy={pending}
        onChange={(e) => {
          change(e.target.value as Locale);
        }}
        className="bg-card text-foreground shadow-control h-8 rounded-md border-0 px-2 text-xs"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {t.app.languageNames[l]}
          </option>
        ))}
      </select>
    </div>
  );
}
