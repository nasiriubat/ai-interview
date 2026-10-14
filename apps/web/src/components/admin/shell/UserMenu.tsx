"use client";

import { LanguagesIcon, LogOutIcon, MonitorIcon, MoonIcon, SunIcon, UserRoundIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { useLocaleSwitch } from "@/components/common/useLocaleSwitch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { LOCALES, type Locale } from "@/i18n/locale";
import type { Me } from "@/lib/api/schemas";
import { applyTheme, readTheme, type ThemeChoice } from "@/lib/theme";

/** Two letters for the avatar: the name's initials, or the start of the email's local part. */
export function initialsOf(me: Me["user"] | null): string {
  if (!me) return "?";
  const source = (me.name?.trim() ? me.name.trim() : undefined) ?? me.email.split("@")[0] ?? "";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : (parts[0] ?? "").slice(0, 2);
  return letters.toUpperCase() || "?";
}

export function Avatar({
  me,
  size = "md",
}: {
  me: Me["user"] | null;
  size?: "md" | "lg";
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={
        size === "lg"
          ? "bg-accent text-accent-foreground grid size-10 shrink-0 place-items-center rounded-full text-sm font-semibold"
          : "bg-accent text-accent-foreground grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold"
      }
    >
      {initialsOf(me)}
    </span>
  );
}

const THEMES: readonly ThemeChoice[] = ["system", "light", "dark"];

/**
 * Everything that belongs to the signed-in person, in one menu in the top bar: profile, theme,
 * language and sign out (D-340). Theme and language apply at once; sign out is a server action.
 */
export function UserMenu({ me }: { me: Me | null }): React.JSX.Element {
  const k = t.kit.shell;
  const [theme, setTheme] = React.useState<ThemeChoice>("system");
  React.useEffect(() => {
    setTheme(readTheme());
  }, []);
  const { shown, change } = useLocaleSwitch();
  const themeLabel: Record<ThemeChoice, string> = {
    system: t.app.theme.system,
    light: t.app.theme.light,
    dark: t.app.theme.dark,
  };
  const ThemeIcon = { system: MonitorIcon, light: SunIcon, dark: MoonIcon };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            aria-label={k.userMenu}
            className="hover:bg-muted data-[state=open]:bg-muted flex h-10 items-center gap-2 rounded-full p-1 transition-colors md:pr-2.5"
          >
            <Avatar me={me?.user ?? null} />
            <span className="hidden min-w-0 text-left md:block">
              <span className="text-foreground block max-w-40 truncate text-[13px] leading-tight font-medium">
                {me?.user.name?.trim() ? me.user.name.trim() : me?.user.email}
              </span>
              <span className="text-muted-foreground block max-w-40 truncate text-xs leading-tight">
                {me ? t.admin.nav.role[me.user.role] : ""}
              </span>
            </span>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{k.userMenu}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent className="w-72">
        {me ? (
          <div className="flex items-center gap-3 px-2.5 py-2">
            <Avatar me={me.user} size="lg" />
            <div className="min-w-0">
              <p className="text-foreground truncate text-sm font-medium">
                {me.user.name?.trim() ? me.user.name.trim() : me.user.email}
              </p>
              <p className="text-muted-foreground truncate text-xs" title={me.user.email}>
                <span className="sr-only">{t.admin.nav.signedInAs(me.user.email)}</span>
                <span aria-hidden="true">{me.user.email}</span>
              </p>
              <p className="text-muted-foreground truncate text-xs">
                {t.admin.nav.role[me.user.role]}
                {me.company ? ` · ${me.company.name}` : ""}
              </p>
            </div>
          </div>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/admin/account">
            <UserRoundIcon aria-hidden="true" />
            {k.account}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t.app.theme.label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(v) => {
            if (THEMES.includes(v as ThemeChoice)) {
              setTheme(v as ThemeChoice);
              applyTheme(v as ThemeChoice);
            }
          }}
        >
          {THEMES.map((choice) => {
            const Icon = ThemeIcon[choice];
            return (
              <DropdownMenuRadioItem
                key={choice}
                value={choice}
                onSelect={(e) => {
                  e.preventDefault();
                }}
              >
                <Icon aria-hidden="true" />
                {themeLabel[choice]}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t.app.language}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={shown}
          onValueChange={(v) => {
            change(v as Locale);
          }}
        >
          {LOCALES.map((l) => (
            <DropdownMenuRadioItem
              key={l}
              value={l}
              onSelect={(e) => {
                e.preventDefault();
              }}
            >
              <LanguagesIcon aria-hidden="true" />
              {t.app.languageNames[l]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild destructive>
          <Link href="/auth/signout">
            <LogOutIcon aria-hidden="true" />
            {t.app.signOut}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
