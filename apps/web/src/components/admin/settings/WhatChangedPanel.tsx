"use client";

import { SparklesIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { actorLabel } from "@/lib/admin/actor";
import { settingAnchor } from "@/lib/admin/settingsSearch";
import type { SettingsCatalogEntry, SettingsHistoryItem } from "@/lib/api/schemas";
import { settingText } from "@/lib/i18n/enums";
import { formatDate } from "@/lib/utils";

const s = t.admin.settings.whatChanged;

const VISIT_KEY = "aidp.settings.lastVisit";
const RELEASE_KEY = "aidp.settings.lastRelease";

interface Seen {
  at: string;
  release: string;
}

function readSeen(): Seen | null {
  try {
    const at = window.localStorage.getItem(VISIT_KEY);
    const release = window.localStorage.getItem(RELEASE_KEY);
    return at && release ? { at, release } : null;
  } catch {
    // Storage can be blocked or empty (a private window); the panel then has nothing to compare to.
    return null;
  }
}

function writeSeen(seen: Seen): void {
  try {
    window.localStorage.setItem(VISIT_KEY, seen.at);
    window.localStorage.setItem(RELEASE_KEY, seen.release);
  } catch {
    // Not remembering is the same as a first visit next time; nothing else depends on it.
  }
}

/**
 * Pure: what is new for someone who last looked at `seen`. Settings that arrived in a later
 * release than the one they saw, and saves by other people after the time they saw. A first visit
 * (`seen` null) has nothing to compare against, so nothing is new: listing every setting as new to
 * someone who has never opened the page would be noise.
 */
export function whatChangedSince(
  seen: Seen | null,
  catalog: Pick<SettingsCatalogEntry, "key" | "since" | "category">[],
  history: SettingsHistoryItem[],
  myEmail: string | undefined,
): { added: { key: string; category: string; since: string }[]; changes: SettingsHistoryItem[] } {
  if (!seen) return { added: [], changes: [] };
  const added = catalog.flatMap((c) =>
    typeof c.since === "string" && c.since > seen.release
      ? [{ key: c.key, category: c.category, since: c.since }]
      : [],
  );
  const changes = history.filter((h) => Date.parse(h.at) > Date.parse(seen.at) && h.actor?.email !== myEmail);
  return { added, changes };
}

/**
 * "What changed since your last visit" (D-180). The last visit is remembered in this browser, not
 * on the account: it is a convenience that costs no table, and a new browser reads as a first
 * visit. The page records the visit after it has compared, so the panel shows once.
 */
export function WhatChangedPanel({
  catalog,
  history,
  release,
  myEmail,
  scope,
  scopeId,
}: {
  catalog: Pick<SettingsCatalogEntry, "key" | "since" | "category">[];
  history: SettingsHistoryItem[];
  release: string;
  myEmail: string | undefined;
  scope: string;
  scopeId: string | undefined;
}): React.JSX.Element | null {
  const [seen, setSeen] = React.useState<Seen | null | undefined>(undefined);
  const [hidden, setHidden] = React.useState(false);

  React.useEffect(() => {
    setSeen(readSeen());
    writeSeen({ at: new Date().toISOString(), release });
  }, [release]);

  const diff = React.useMemo(
    () => whatChangedSince(seen ?? null, catalog, history, myEmail),
    [seen, catalog, history, myEmail],
  );
  if (hidden || seen === undefined || (diff.added.length === 0 && diff.changes.length === 0)) return null;

  const href = (e: { key: string; category: string }): string => {
    const params = new URLSearchParams({ scope });
    if (scopeId) params.set("scopeId", scopeId);
    params.set("category", e.category);
    return `/admin/settings?${params.toString()}#${settingAnchor(e.key)}`;
  };
  const nameOf = (key: string): string => settingText(key)?.label ?? key;

  return (
    <section
      aria-labelledby="what-changed-title"
      className="bg-card shadow-card grid gap-3 rounded-lg border-l-4 border-l-[var(--primary)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="what-changed-title" className="flex items-center gap-2 text-[15px] font-semibold">
          <SparklesIcon className="size-4" aria-hidden="true" /> {s.title}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setHidden(true);
          }}
        >
          {s.seen}
        </Button>
      </div>
      {diff.added.length > 0 ? (
        <div className="grid gap-1 text-sm">
          <p className="font-medium">{s.newSettings(diff.added.length, release)}</p>
          <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
            {diff.added.slice(0, 12).map((a) => (
              <li key={a.key}>
                <Link className="text-primary underline-offset-2 hover:underline" href={href(a)}>
                  {nameOf(a.key)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {diff.changes.length > 0 ? (
        <div className="grid gap-1 text-sm">
          <p className="font-medium">{s.changes(diff.changes.length)}</p>
          <ul className="text-muted-foreground grid gap-1">
            {diff.changes.slice(0, 8).map((c) => (
              <li key={c.id}>
                {s.line(
                  actorLabel(c.actor, t.admin.settings.history.system),
                  [
                    ...c.keys.filter((k) => !c.cleared.includes(k)).map(nameOf),
                    ...c.cleared.map((k) => `${nameOf(k)} (${s.resetSuffix})`),
                  ].join(", "),
                  formatDate(c.at),
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
