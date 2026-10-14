"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { ToggleGroup } from "radix-ui";
import * as React from "react";
import { t } from "@/i18n";
import { applyTheme, readTheme, type ThemeChoice } from "@/lib/theme";
import { cn } from "@/lib/utils";

const CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];

/**
 * System, Light or Dark (D-238). A one-of-three toggle group: one tab stop, the arrow keys move
 * between the choices, and each choice carries its name (the phone layout shows only the icon).
 * The choice applies at once and is remembered in this browser.
 */
export function ThemeSwitch({
  className,
  compact = false,
}: {
  className?: string;
  /** Icons only, at every width (the landing header, where room is tight). */
  compact?: boolean;
}): React.JSX.Element {
  const s = t.app.theme;
  // "system" on the server and on the first client render, so hydration matches; the stored choice
  // is read right after.
  const [choice, setChoice] = React.useState<ThemeChoice>("system");
  React.useEffect(() => {
    setChoice(readTheme());
  }, []);
  const labels: Record<ThemeChoice, [string, typeof SunIcon]> = {
    system: [s.system, MonitorIcon],
    light: [s.light, SunIcon],
    dark: [s.dark, MoonIcon],
  };
  return (
    <ToggleGroup.Root
      type="single"
      value={choice}
      onValueChange={(v) => {
        if (CHOICES.includes(v as ThemeChoice)) {
          setChoice(v as ThemeChoice);
          applyTheme(v as ThemeChoice);
        }
      }}
      aria-label={s.label}
      rovingFocus
      loop
      className={cn("bg-muted inline-flex rounded-lg p-0.5", className)}
    >
      {CHOICES.map((value) => {
        const [label, Icon] = labels[value];
        return (
          <ToggleGroup.Item
            key={value}
            value={value}
            aria-label={label}
            className={cn(
              "inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
              choice === value
                ? "bg-card text-primary shadow-control"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            <span aria-hidden="true" className={compact ? "hidden" : "hidden xl:inline"}>
              {label}
            </span>
          </ToggleGroup.Item>
        );
      })}
    </ToggleGroup.Root>
  );
}
