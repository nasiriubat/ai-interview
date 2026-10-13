import Link from "next/link";
import * as React from "react";
import { CategoryForm } from "./CategoryForm";
import { LiveVoicePanel } from "./LiveVoicePanel";
import { t } from "@/i18n";
import type { SettingsCatalogEntry, SettingsResponse } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

const CATEGORY_ORDER = [
  "engine",
  "campaign",
  "privacy",
  "cost",
  "files",
  "voice",
  "features",
  "branding",
  "analysis",
  "requirements",
  "exports",
  "email",
  "notifications",
  "ops",
  "other",
];

function categoryLabel(key: string): string {
  const labels: Record<string, string> = t.admin.settings.categories;
  return labels[key] ?? key;
}

/**
 * The settings screen: categories down the left (above the form on phones), one category's
 * form on the right. The selection lives in `?category=`, so a reload or a shared link opens
 * the same category.
 */
export function SettingsCategories({
  data,
  scope,
  scopeId,
  category,
}: {
  data: SettingsResponse;
  scope: string;
  scopeId: string | undefined;
  category: string | undefined;
}): React.JSX.Element {
  const s = t.admin.settings;
  const catalog = data.catalog.filter((c) => c.scopes.length === 0 || c.scopes.includes(scope));
  const grouped = new Map<string, SettingsCatalogEntry[]>();
  for (const entry of catalog) {
    const list = grouped.get(entry.category) ?? [];
    list.push(entry);
    grouped.set(entry.category, list);
  }
  const categories = [...grouped.keys()].sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  if (categories.length === 0) return <p className="text-muted-foreground text-sm">{s.empty}</p>;

  const selected = category && grouped.has(category) ? category : (categories[0] ?? "");
  const entries = grouped.get(selected) ?? [];

  const href = (cat: string): string => {
    const params = new URLSearchParams({ scope });
    if (scopeId) params.set("scopeId", scopeId);
    params.set("category", cat);
    return `/admin/settings?${params.toString()}`;
  };

  return (
    <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
      <nav
        aria-label={s.categoriesLabel}
        className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0"
      >
        {categories.map((cat) => (
          <Link
            key={cat}
            href={href(cat)}
            aria-current={cat === selected ? "page" : undefined}
            className={cn(
              "hover:bg-accent shrink-0 rounded-md px-3 py-1.5 text-sm whitespace-nowrap",
              cat === selected && "bg-accent font-medium",
            )}
          >
            {categoryLabel(cat)}
          </Link>
        ))}
      </nav>
      <div className="min-w-0">
        {/* Live voice is one switch with a readiness check (D-77), and it is always the tenant's own. */}
        {selected === "voice" && scope === "tenant" && !scopeId ? <LiveVoicePanel /> : null}
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
        />
      </div>
    </div>
  );
}
