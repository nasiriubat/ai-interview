"use client";

import { MoonIcon, SunIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { applyTheme } from "@/lib/theme";
import { useTheme } from "@/lib/useTheme";
import { cn } from "@/lib/utils";

/**
 * Light or dark, one button (D-485). It shows the theme in effect, the device's own until somebody
 * picks, and switches to the other one; the choice is remembered in this browser. It is a toggle
 * named "Dark mode", pressed when dark, so a screen reader hears the state rather than an icon.
 * Going back to following the device is on the account page, not here: a third state behind an
 * icon was what made this control confusing.
 */
export function ThemeToggle({
  className,
  showName = false,
}: {
  className?: string;
  /** Shows the theme's name beside the icon (menus and sheets that have room). */
  showName?: boolean;
}): React.JSX.Element {
  const s = t.app.theme;
  const { theme } = useTheme();
  const Icon = theme === "dark" ? MoonIcon : SunIcon;
  return (
    <Button
      type="button"
      variant="ghost"
      size={showName ? "sm" : "icon-sm"}
      className={cn(showName ? "justify-between" : "", className)}
      aria-label={s.darkMode}
      aria-pressed={theme === null ? undefined : theme === "dark"}
      title={s.darkMode}
      onClick={() => {
        if (theme !== null) applyTheme(theme === "dark" ? "light" : "dark");
      }}
    >
      {/* Before mount the theme is not known yet: the button keeps its size, without a guess. */}
      {theme === null ? <span className="size-4" aria-hidden="true" /> : <Icon aria-hidden="true" />}
      {showName ? (
        <span aria-hidden="true" className="font-semibold">
          {theme === "dark" ? s.dark : s.light}
        </span>
      ) : null}
    </Button>
  );
}
