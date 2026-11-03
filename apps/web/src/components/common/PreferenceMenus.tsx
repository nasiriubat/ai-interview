"use client";

import { CheckIcon, ChevronDownIcon, GlobeIcon } from "lucide-react";
import * as React from "react";
import { useLocaleSwitch } from "@/components/common/useLocaleSwitch";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";
import { LOCALES, type Locale } from "@/i18n/locale";

/**
 * Language as one compact control: a globe and the short code, opening a short list with the
 * language names and a check on the current one. Replaces the native select, which looked out of
 * place beside the other controls and could not be styled.
 */
export function LanguageMenu({
  align = "end",
  side = "bottom",
  showName = false,
  className,
}: {
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  /** Shows the language name beside the globe (the mobile menu and the footer have room). */
  showName?: boolean;
  className?: string;
}): React.JSX.Element {
  const { shown, pending, change } = useLocaleSwitch();
  const names = t.app.languageNames;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={className}
          disabled={pending}
          aria-busy={pending}
          aria-label={`${t.app.language}: ${names[shown]}`}
        >
          <GlobeIcon aria-hidden="true" />
          <span aria-hidden="true" className="font-semibold">
            {showName ? names[shown] : shown.toUpperCase()}
          </span>
          <ChevronDownIcon className="text-muted-foreground -mr-0.5 size-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} side={side} className="min-w-40">
        {LOCALES.map((l: Locale) => (
          <DropdownMenuItem
            key={l}
            lang={l}
            onSelect={() => {
              change(l);
            }}
            className="justify-between"
          >
            <span>{names[l]}</span>
            {l === shown ? <CheckIcon className="text-primary size-4" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
