import { PencilIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { SectionTitle } from "@/components/admin/Panel";
import { DataTable } from "@/components/data/DataTable";
import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import { PROMPT_GROUPS, type PromptGroup, type PromptSummary } from "@/lib/api/schemas";
import { formatPercent } from "@/lib/utils";

/** The localized name of a prompt key; a key nobody has named yet is shown as it is. */
export function promptName(key: string): string {
  const names: Record<string, { name: string } | undefined> = t.admin.prompts.names;
  return names[key]?.name ?? key;
}

export function promptDescription(key: string): string | undefined {
  const names: Record<string, { description: string } | undefined> = t.admin.prompts.names;
  return names[key]?.description;
}

/**
 * Every prompt, grouped by what it is for, with what is in use and how it has been doing (D-363).
 * The set is fixed and small, so each group is one table on one page; the row's one action is to
 * open the prompt.
 */
export function PromptsTable({
  prompts,
  windowDays,
}: {
  prompts: PromptSummary[];
  windowDays: number;
}): React.JSX.Element {
  const groups = PROMPT_GROUPS.map((group) => ({
    group,
    rows: prompts.filter((p) => p.group === group),
  })).filter((g) => g.rows.length > 0);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8">
      {groups.map(({ group, rows }) => (
        <GroupTable key={group} group={group} rows={rows} windowDays={windowDays} />
      ))}
    </div>
  );
}

function GroupTable({
  group,
  rows,
  windowDays,
}: {
  group: PromptGroup;
  rows: PromptSummary[];
  windowDays: number;
}): React.JSX.Element {
  const s = t.admin.prompts;
  const headingId = `prompt-group-${group}`;
  return (
    <section aria-labelledby={headingId} className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div>
        <SectionTitle id={headingId}>{s.groups[group]}</SectionTitle>
        <p className="text-muted-foreground mt-0.5 text-[13px]">{s.windowNote(windowDays)}</p>
      </div>
      <DataTable
        id={`prompts-${group}`}
        label={s.groups[group]}
        columns={[
          { id: "prompt", header: s.columns.prompt, primary: true, locked: true },
          { id: "serving", header: s.columns.serving, locked: true },
          { id: "builtIn", header: s.columns.builtIn, locked: true },
          { id: "calls", header: s.columns.calls, align: "end", locked: true },
          { id: "errors", header: s.columns.errors, align: "end", locked: true },
        ]}
        rows={rows.map((p) => ({
          id: p.key,
          label: promptName(p.key),
          cells: {
            prompt: (
              <span className="block max-w-md min-w-0">
                <Link
                  href={`/admin/prompts/${encodeURIComponent(p.key)}`}
                  className="text-foreground font-medium hover:underline"
                >
                  {promptName(p.key)}
                </Link>
                <span className="text-muted-foreground mt-0.5 block text-xs">
                  <code className="font-mono">{p.key}</code>
                  {promptDescription(p.key) ? ` · ${promptDescription(p.key) ?? ""}` : ""}
                </span>
              </span>
            ),
            serving: (
              <span className="whitespace-nowrap">
                <Badge variant={p.effective.source === "tenant" ? "default" : "secondary"}>
                  {s.source[p.effective.source]}
                </Badge>{" "}
                <code className="font-mono text-xs">{p.effective.tag}</code>
                {p.canary ? (
                  <Badge variant="warning" className="ml-1.5">
                    {s.canaryBadge(Math.round(p.canary.share * 100))}
                  </Badge>
                ) : null}
              </span>
            ),
            builtIn: <code className="font-mono text-xs">{p.shipped.tag}</code>,
            calls: <span className="tabular-nums">{p.stats.calls}</span>,
            errors: (
              <span className="tabular-nums">
                {p.stats.calls > 0 ? formatPercent(p.stats.errorRate) : t.admin.common.dash}
              </span>
            ),
          },
          actions: (
            <RowActions>
              <IconButton
                label={`${t.admin.actions.edit}: ${promptName(p.key)}`}
                icon={<PencilIcon />}
                href={`/admin/prompts/${encodeURIComponent(p.key)}`}
              />
            </RowActions>
          ),
        }))}
        page={{ page: 1, limit: Math.max(rows.length, 1), count: rows.length, total: rows.length }}
      />
    </section>
  );
}
