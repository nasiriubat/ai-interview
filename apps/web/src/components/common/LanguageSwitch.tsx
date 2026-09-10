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
export function LanguageSwitch({ className }: { className?: string }): React.JSX.Element {
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
      <LanguagesIcon className="text-muted-foreground size-4" aria-hidden="true" />
      <label className="sr-only" htmlFor="language-switch">
        {t.app.language}
      </label>
      <select
        id="language-switch"
        value={shown}
        disabled={pending}
        aria-busy={pending}
        onChange={(e) => {
          change(e.target.value as Locale);
        }}
        className="border-input bg-background focus-visible:ring-ring/50 h-8 rounded-md border px-2 text-xs outline-none focus-visible:ring-[3px]"
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
