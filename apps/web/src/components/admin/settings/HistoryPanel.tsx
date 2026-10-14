import * as React from "react";
import { Panel } from "@/components/admin/Panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { actorLabel } from "@/lib/admin/actor";
import type { SettingsHistoryItem } from "@/lib/api/schemas";
import { settingText } from "@/lib/i18n/enums";
import { formatDate } from "@/lib/utils";

/**
 * Who changed which settings and when (D-182). The audit log records the keys and never a value,
 * so this says what was touched, not what it became; a secret cannot leak through it.
 */
export function HistoryPanel({ items }: { items: SettingsHistoryItem[] }): React.JSX.Element {
  const s = t.admin.settings.history;
  const levels: Record<string, string> = t.admin.settings.scopes;
  return (
    <Panel title={s.title} description={s.description}>
      {items.length === 0 ? (
        <p className="text-muted-foreground px-5 py-4 text-sm">{s.empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{s.when}</TableHead>
                <TableHead>{s.who}</TableHead>
                <TableHead>{s.level}</TableHead>
                <TableHead>{s.settings}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                    {formatDate(i.at)}
                  </TableCell>
                  <TableCell>{actorLabel(i.actor, s.system)}</TableCell>
                  <TableCell>
                    {levels[i.scope] ?? i.scope}
                    {i.scopeName ? <span className="text-muted-foreground"> · {i.scopeName}</span> : null}
                  </TableCell>
                  <TableCell>
                    <ul className="grid gap-0.5">
                      {i.keys.map((k) => (
                        <li key={k}>
                          {settingText(k)?.label ?? k}
                          {i.cleared.includes(k) ? (
                            <span className="text-muted-foreground"> ({s.reset})</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}
