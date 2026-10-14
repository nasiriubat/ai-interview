import Link from "next/link";
import * as React from "react";
import { Panel } from "@/components/admin/Panel";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

/** Every prompt, grouped by what it is for, with what is in use and how it has been doing. */
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
    <div className="grid gap-6">
      {groups.map(({ group, rows }) => (
        <GroupPanel key={group} group={group} rows={rows} windowDays={windowDays} />
      ))}
    </div>
  );
}

function GroupPanel({
  group,
  rows,
  windowDays,
}: {
  group: PromptGroup;
  rows: PromptSummary[];
  windowDays: number;
}): React.JSX.Element {
  const s = t.admin.prompts;
  return (
    <Panel title={s.groups[group]} description={s.windowNote(windowDays)}>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{s.columns.prompt}</TableHead>
              <TableHead>{s.columns.serving}</TableHead>
              <TableHead>{s.columns.builtIn}</TableHead>
              <TableHead className="text-right">{s.columns.calls}</TableHead>
              <TableHead className="text-right">{s.columns.errors}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <TableRow key={p.key}>
                <TableCell className="max-w-md">
                  <Link
                    href={`/admin/prompts/${encodeURIComponent(p.key)}`}
                    className="text-primary font-medium underline-offset-2 hover:underline"
                  >
                    {promptName(p.key)}
                  </Link>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    <code className="font-mono">{p.key}</code>
                    {promptDescription(p.key) ? ` · ${promptDescription(p.key) ?? ""}` : ""}
                  </p>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Badge variant={p.effective.source === "tenant" ? "default" : "secondary"}>
                    {s.source[p.effective.source]}
                  </Badge>{" "}
                  <code className="font-mono text-xs">{p.effective.tag}</code>
                  {p.canary ? (
                    <Badge variant="warning" className="ml-1.5">
                      {s.canaryBadge(Math.round(p.canary.share * 100))}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <code className="font-mono text-xs">{p.shipped.tag}</code>
                </TableCell>
                <TableCell className="text-right tabular-nums">{p.stats.calls}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {p.stats.calls > 0 ? formatPercent(p.stats.errorRate) : t.admin.common.dash}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Panel>
  );
}
