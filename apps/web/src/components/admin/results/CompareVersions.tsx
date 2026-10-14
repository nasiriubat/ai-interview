"use client";

import { ArrowRightIcon, Loader2Icon } from "lucide-react";
import * as React from "react";
import { ClassBadge, RankMeter } from "./ClassBadge";
import { Panel } from "@/components/admin/Panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Combobox } from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { effectiveClass, effectiveTitle } from "@/lib/analysis/rank";
import { staffClient } from "@/lib/api/browser";
import { errorMessage } from "@/lib/api/errors";
import type { Analysis, AnalysisDiff, Opportunity } from "@/lib/api/schemas";

function SimpleRows({ items }: { items: Opportunity[] }): React.JSX.Element {
  return (
    <>
      {items.map((o) => (
        <TableRow key={o.id}>
          <TableCell className="font-medium">{effectiveTitle(o)}</TableCell>
          <TableCell>
            <ClassBadge solutionClass={effectiveClass(o)} />
          </TableCell>
          <TableCell>
            <RankMeter score={o.rankScore} compact />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

export function CompareVersions({
  current,
  analyses,
}: {
  current: Analysis;
  analyses: Analysis[];
}): React.JSX.Element {
  const s = t.admin.results.compare;
  const others = analyses.filter((a) => a.id !== current.id && a.status === "done");
  const [otherId, setOtherId] = React.useState("");
  const [diff, setDiff] = React.useState<AnalysisDiff | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!otherId) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    staffClient.analyses
      .diff(current.id, otherId)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e, t.app.unknownError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [current.id, otherId]);

  const empty = diff && diff.added.length + diff.removed.length + diff.changed.length === 0;
  return (
    <Panel title={s.title} description={s.body} headingLevel={3} className="print:hidden">
      <div className="grid gap-4 px-5 py-4">
        {others.length === 0 ? (
          <p className="text-muted-foreground text-sm">{s.noOther}</p>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor="compare-version">{s.pick}</Label>
            <Combobox
              id="compare-version"
              className="max-w-xs"
              value={otherId}
              onChange={setOtherId}
              options={[
                { value: "", label: s.none },
                ...others.map((a) => ({
                  value: a.id,
                  label: t.admin.results.versionOption(a.version, t.admin.results.status[a.status]),
                })),
              ]}
              labels={{
                placeholder: s.none,
                search: t.admin.list.searchPlaceholder,
                empty: t.admin.list.noMatches,
              }}
            />
          </div>
        )}
        {loading ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
            <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{" "}
            {s.loading}
          </p>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {empty ? <p className="text-muted-foreground text-sm">{s.noChanges}</p> : null}
        {diff && diff.added.length > 0 ? (
          <section aria-label={s.added}>
            <h3 className="mb-1 text-sm font-medium">
              {s.added} ({diff.added.length})
            </h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.admin.dashboard.opportunity}</TableHead>
                  <TableHead>{t.admin.dashboard.class}</TableHead>
                  <TableHead>{t.admin.results.rank}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <SimpleRows items={diff.added} />
              </TableBody>
            </Table>
          </section>
        ) : null}
        {diff && diff.removed.length > 0 ? (
          <section aria-label={s.removed}>
            <h3 className="mb-1 text-sm font-medium">
              {s.removed} ({diff.removed.length})
            </h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.admin.dashboard.opportunity}</TableHead>
                  <TableHead>{t.admin.dashboard.class}</TableHead>
                  <TableHead>{t.admin.results.rank}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <SimpleRows items={diff.removed} />
              </TableBody>
            </Table>
          </section>
        ) : null}
        {diff && diff.changed.length > 0 ? (
          <section aria-label={s.changed}>
            <h3 className="mb-1 text-sm font-medium">
              {s.changed} ({diff.changed.length})
            </h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.admin.dashboard.opportunity}</TableHead>
                  <TableHead>{s.before}</TableHead>
                  <TableHead />
                  <TableHead>{s.after}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {diff.changed.map(({ before, after }) => (
                  <TableRow key={after.id}>
                    <TableCell className="font-medium">
                      {effectiveTitle(after)}
                      {effectiveTitle(before) !== effectiveTitle(after) ? (
                        <span className="text-muted-foreground block text-xs line-through">
                          {effectiveTitle(before)}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="grid gap-1">
                        <ClassBadge solutionClass={effectiveClass(before)} />
                        <RankMeter score={before.rankScore} compact />
                      </div>
                    </TableCell>
                    <TableCell>
                      <ArrowRightIcon className="text-muted-foreground size-4" aria-hidden="true" />
                    </TableCell>
                    <TableCell>
                      <div className="grid gap-1">
                        <ClassBadge solutionClass={effectiveClass(after)} />
                        <RankMeter score={after.rankScore} compact />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        ) : null}
      </div>
    </Panel>
  );
}
