"use client";

import Link from "next/link";
import * as React from "react";
import { useDirtyGuard } from "@/components/common/DirtyGuard";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

export interface SettingsNavItem {
  key: string;
  label: string;
  href: string;
  /** Settings in this section that differ from their default. */
  changed: number;
}

export interface SettingsNavGroup {
  key: string;
  label: string;
  items: SettingsNavItem[];
}

/**
 * The settings side navigation (D-394): grouped links on a wide screen, one select on a narrow
 * one. Both go through the dirty guard, so leaving a section with unsaved edits asks first. A
 * badge counts what differs from the default in each section.
 */
export function SettingsNav({
  groups,
  selected,
}: {
  groups: SettingsNavGroup[];
  selected: string;
}): React.JSX.Element {
  const k = t.kit.settingsLayout;
  const guard = useDirtyGuard();
  const all = groups.flatMap((g) => g.items);
  const go = (href: string): void => {
    guard.navigate(href);
  };
  return (
    <>
      <div className="grid gap-1.5 lg:hidden">
        <Label htmlFor="settings-section">{k.pickSection}</Label>
        <Select
          value={selected}
          onValueChange={(v) => {
            const item = all.find((i) => i.key === v);
            if (item) go(item.href);
          }}
        >
          <SelectTrigger id="settings-section" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {groups.map((g) => (
              <SelectGroup key={g.key}>
                <SelectLabel>{g.label}</SelectLabel>
                {g.items.map((i) => (
                  <SelectItem key={i.key} value={i.key}>
                    {i.label}
                    {i.changed > 0 ? ` · ${k.changed(i.changed)}` : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
      <nav aria-label={k.navLabel} className="hidden gap-5 lg:grid">
        {groups.map((g) => (
          <div key={g.key} className="grid gap-1">
            <p className="text-muted-foreground px-3 text-xs font-semibold tracking-wide uppercase">
              {g.label}
            </p>
            <ul className="grid gap-0.5">
              {g.items.map((i) => {
                const active = i.key === selected;
                return (
                  <li key={i.key}>
                    <Link
                      href={i.href}
                      aria-current={active ? "page" : undefined}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                        e.preventDefault();
                        go(i.href);
                      }}
                      className={cn(
                        "flex items-center justify-between gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                        active
                          ? "bg-accent text-accent-foreground font-medium"
                          : "text-foreground hover:bg-muted",
                      )}
                    >
                      <span className="truncate">{i.label}</span>
                      {i.changed > 0 ? (
                        <Badge variant="secondary" aria-label={k.changed(i.changed)}>
                          {i.changed}
                        </Badge>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );
}
