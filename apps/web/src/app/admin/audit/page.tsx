import type { Metadata } from "next";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { PageHeader } from "@/components/admin/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import type { AuditEntry } from "@/lib/api/schemas";
import { staffServer } from "@/lib/api/server";
import { formatDate } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.audit.title };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function actorOf(e: AuditEntry): string {
  if (e.actorEmail) return e.actorEmail;
  if (typeof e.actor === "string") return e.actor;
  if (e.actor && typeof e.actor === "object") {
    const a = e.actor as { email?: unknown; name?: unknown; id?: unknown };
    const first = [a.email, a.name, a.id].find((x) => typeof x === "string");
    return typeof first === "string" ? first : "";
  }
  return e.userId ?? "";
}

function targetOf(e: AuditEntry): string {
  if (typeof e.target === "string") return e.target;
  if (e.targetType || e.targetId) return [e.targetType, e.targetId].filter(Boolean).join(" ");
  if (e.target && typeof e.target === "object") return JSON.stringify(e.target);
  return "";
}

export default async function AuditPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requireMe();
  const sp = await searchParams;
  const to = typeof sp.to === "string" && sp.to ? sp.to : new Date().toISOString().slice(0, 10);
  const from =
    typeof sp.from === "string" && sp.from
      ? sp.from
      : new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const api = await staffServer();
  const entries = await api.audit({
    from: new Date(from).toISOString(),
    to: new Date(`${to}T23:59:59Z`).toISOString(),
  });
  const s = t.admin.audit;
  return (
    <>
      <PageHeader title={s.title} subtitle={s.subtitle} />
      <form className="mb-6 flex flex-wrap items-end gap-3" method="get">
        <div className="grid gap-1.5">
          <Label htmlFor="from">{s.from}</Label>
          <Input id="from" name="from" type="date" defaultValue={from} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="to">{s.to}</Label>
          <Input id="to" name="to" type="date" defaultValue={to} />
        </div>
        <Button type="submit" variant="outline">
          {s.filter}
        </Button>
      </form>
      {entries.length === 0 ? (
        <EmptyState text={s.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{s.at}</TableHead>
              <TableHead>{s.actor}</TableHead>
              <TableHead>{s.action}</TableHead>
              <TableHead>{s.target}</TableHead>
              <TableHead>{s.details}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e, i) => (
              <TableRow key={e.id ?? i}>
                <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                  {formatDate(e.createdAt ?? e.at)}
                </TableCell>
                <TableCell>{actorOf(e)}</TableCell>
                <TableCell className="font-mono text-xs">{e.action}</TableCell>
                <TableCell className="font-mono text-xs">{targetOf(e)}</TableCell>
                <TableCell className="max-w-md">
                  {e.diff !== undefined && e.diff !== null ? (
                    <pre className="max-h-32 overflow-auto text-xs whitespace-pre-wrap">
                      {JSON.stringify(e.diff, null, 1)}
                    </pre>
                  ) : e.details !== undefined && e.details !== null ? (
                    <pre className="max-h-32 overflow-auto text-xs whitespace-pre-wrap">
                      {JSON.stringify(e.details, null, 1)}
                    </pre>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
