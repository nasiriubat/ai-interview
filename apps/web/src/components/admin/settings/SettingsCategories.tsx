import * as React from "react";
import { CategoryForm } from "./CategoryForm";
import { LiveVoicePanel } from "./LiveVoicePanel";
import { SettingsNav, type SettingsNavGroup } from "./SettingsNav";
import { SettingsSearch } from "./SettingsSearch";
import { t } from "@/i18n";
import type { SettingsCatalogEntry, SettingsResponse } from "@/lib/api/schemas";

/** The sections in a group, in reading order. A category not listed lands in "other". */
const GROUPS: { key: "interview" | "costs" | "workspace" | "insight" | "other"; categories: string[] }[] = [
  { key: "interview", categories: ["engine", "campaign", "privacy", "features", "voice"] },
  { key: "costs", categories: ["cost", "ceiling", "ops"] },
  { key: "workspace", categories: ["branding", "email", "notifications", "files", "sales"] },
  { key: "insight", categories: ["analysis", "requirements", "exports"] },
  { key: "other", categories: ["other"] },
];

/**
 * Categories that hold state rather than configuration: `ui.*` remembers that a card was
 * dismissed. It is in the catalog so it has a scope and a history, and it stays off this screen.
 */
const HIDDEN_CATEGORIES = new Set(["ui"]);

function categoryLabel(key: string): string {
  const labels: Record<string, string> = t.admin.settings.categories;
  return labels[key] ?? key;
}

/**
 * The settings screen (D-394): a search box and grouped sections down the left (a select above
 * the form on phones), one section's form on the right. The selection lives in `?category=`, so a
 * reload or a shared link opens the same section; the badge on a section counts what differs from
 * the default at this level.
 */
export function SettingsCategories({
  data,
  scope,
  scopeId,
  category,
  operator = false,
}: {
  data: SettingsResponse;
  scope: string;
  scopeId: string | undefined;
  category: string | undefined;
  operator?: boolean;
}): React.JSX.Element {
  const s = t.admin.settings;
  const catalog = data.catalog.filter(
    (c) => !HIDDEN_CATEGORIES.has(c.category) && (c.scopes.length === 0 || c.scopes.includes(scope)),
  );
  const grouped = new Map<string, SettingsCatalogEntry[]>();
  for (const entry of catalog) {
    const list = grouped.get(entry.category) ?? [];
    list.push(entry);
    grouped.set(entry.category, list);
  }
  if (grouped.size === 0) return <p className="text-muted-foreground text-sm">{s.empty}</p>;

  const href = (cat: string): string => {
    const params = new URLSearchParams({ scope });
    if (scopeId) params.set("scopeId", scopeId);
    params.set("category", cat);
    return `/admin/settings?${params.toString()}`;
  };

  const known = new Set(GROUPS.flatMap((g) => g.categories));
  const navGroups: SettingsNavGroup[] = GROUPS.map((g) => {
    const cats = [
      ...g.categories,
      ...(g.key === "other" ? [...grouped.keys()].filter((c) => !known.has(c)) : []),
    ];
    return {
      key: g.key,
      label: t.kit.settingsLayout.groups[g.key],
      items: cats
        .filter((c) => grouped.has(c))
        .map((c) => ({
          key: c,
          label: categoryLabel(c),
          href: href(c),
          changed: (grouped.get(c) ?? []).filter((e) => e.key in data.values).length,
        })),
    };
  }).filter((g) => g.items.length > 0);

  const first = navGroups[0]?.items[0]?.key ?? "";
  const selected = category && grouped.has(category) ? category : first;
  const entries = grouped.get(selected) ?? [];
  const searchable = data.catalog.filter((c) => c.category !== "ui" && c.scopes.includes(scope));

  return (
    <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8">
      <div className="grid content-start gap-5 lg:sticky lg:top-20 lg:self-start">
        <SettingsSearch entries={searchable} scope={scope} scopeId={scopeId} />
        <SettingsNav groups={navGroups} selected={selected} />
      </div>
      <div className="min-w-0">
        {/* Live voice is one switch with a readiness check (D-77), and it is always the tenant's own. */}
        {/* Live calls are switched by the platform operator only (D-476); a tenant admin sees the
            catalog row read-only and no panel to connect a key for a feature they cannot turn on. */}
        {selected === "voice" && scope === "tenant" && !scopeId && operator ? <LiveVoicePanel /> : null}
        <CategoryForm
          key={`${scope}:${scopeId ?? ""}:${selected}`}
          category={selected}
          title={categoryLabel(selected)}
          entries={entries}
          values={data.values}
          effective={data.effective ?? data.values}
          secrets={data.secrets ?? {}}
          sources={data.sources ?? {}}
          scope={scope}
          scopeId={scopeId}
          operator={operator}
          smtp={data.smtp}
        />
      </div>
    </div>
  );
}
