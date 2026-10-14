"use client";

import { CheckIcon, ChevronDownIcon, GlobeIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import * as React from "react";
import { useLocaleSwitch } from "@/components/common/useLocaleSwitch";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";
import { LOCALES, type Locale } from "@/i18n/locale";
import { applyTheme, readTheme, type ThemeChoice } from "@/lib/theme";

const THEMES: readonly ThemeChoice[] = ["system", "light", "dark"];

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

/**
 * Theme as one icon button that shows the current effective theme and opens System, Light and
 * Dark. The choice applies at once and is remembered in this browser (D-238).
 */
export function ThemeMenu({
  align = "end",
  side = "bottom",
  showName = false,
  className,
}: {
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  showName?: boolean;
  className?: string;
}): React.JSX.Element {
  const s = t.app.theme;
  // "system" until mounted so server and client markup agree; the stored choice is read after.
  const [choice, setChoice] = React.useState<ThemeChoice>("system");
  React.useEffect(() => {
    setChoice(readTheme());
  }, []);
  const label: Record<ThemeChoice, string> = { system: s.system, light: s.light, dark: s.dark };
  const Icon = choice === "light" ? SunIcon : choice === "dark" ? MoonIcon : MonitorIcon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={showName ? "sm" : "icon-sm"}
          className={className}
          aria-label={`${s.label}: ${label[choice]}`}
        >
          <Icon aria-hidden="true" />
          {showName ? (
            <>
              <span aria-hidden="true" className="font-semibold">
                {label[choice]}
              </span>
              <ChevronDownIcon className="text-muted-foreground -mr-0.5 size-3.5" aria-hidden="true" />
            </>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} side={side} className="min-w-40">
        <DropdownMenuRadioGroup
          value={choice}
          onValueChange={(v) => {
            if (THEMES.includes(v as ThemeChoice)) {
              setChoice(v as ThemeChoice);
              applyTheme(v as ThemeChoice);
            }
          }}
        >
          {THEMES.map((value) => {
            const ItemIcon = value === "light" ? SunIcon : value === "dark" ? MoonIcon : MonitorIcon;
            return (
              <DropdownMenuRadioItem key={value} value={value}>
                <ItemIcon className="text-muted-foreground size-4" aria-hidden="true" />
                {label[value]}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
