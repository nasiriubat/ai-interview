"use client";

import { SearchIcon, XIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { searchSettings, settingAnchor } from "@/lib/admin/settingsSearch";
import type { SettingsCatalogEntry } from "@/lib/api/schemas";
import { settingText } from "@/lib/i18n/enums";

const s = t.admin.settings;

/**
 * Finds a setting by what it is called, in either language, without opening every category. A
 * result is a link to the category with the control's anchor, so following it lands on the field.
 * Client-side over the catalog the page already has: nothing is requested while typing.
 */
export function SettingsSearch({
  entries,
  scope,
  scopeId,
}: {
  entries: SettingsCatalogEntry[];
  scope: string;
  scopeId: string | undefined;
}): React.JSX.Element {
  const [query, setQuery] = React.useState("");
  const inputId = React.useId();
  const results = React.useMemo(() => searchSettings(query, entries), [query, entries]);
  const categoryNames: Record<string, string> = s.categories;

  const href = (e: SettingsCatalogEntry): string => {
    const params = new URLSearchParams({ scope });
    if (scopeId) params.set("scopeId", scopeId);
    params.set("category", e.category);
    return `/admin/settings?${params.toString()}#${settingAnchor(e.key)}`;
  };

  return (
    <div className="grid gap-2" role="search">
      <Label htmlFor={inputId} className="sr-only">
        {s.search.label}
      </Label>
      <div className="relative max-w-md">
        <SearchIcon
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          id={inputId}
          type="search"
          className="pr-10 pl-9"
          placeholder={s.search.placeholder}
          value={query}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        {query ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute top-1/2 right-1 size-8 -translate-y-1/2"
            aria-label={s.search.clear}
            onClick={() => {
              setQuery("");
            }}
          >
            <XIcon aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {query.trim() ? (
        <div className="bg-card shadow-card rounded-lg">
          <p className="text-muted-foreground border-b px-4 py-2 text-xs" role="status">
            {results.length === 0 ? s.search.none : s.search.results(results.length)}
          </p>
          {results.length > 0 ? (
            <ul className="divide-y">
              {results.slice(0, 12).map((e) => (
                <li key={e.key}>
                  <Link href={href(e)} className="hover:bg-accent grid gap-0.5 px-4 py-2.5 text-sm">
                    <span className="font-medium">{settingText(e.key)?.label ?? e.key}</span>
                    <span className="text-muted-foreground text-xs">
                      {s.search.inCategory(categoryNames[e.category] ?? e.category)}
                      {" · "}
                      <span className="font-mono">{e.key}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
