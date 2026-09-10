import { PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { PageHeader } from "@/components/admin/PageHeader";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";
import { formatDate } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.templates.title };
}

export default async function TemplatesPage(): Promise<React.JSX.Element> {
  await requireMe();
  const api = await staffServer();
  const templates = await api.templates.list();
  const s = t.admin.templates;
  return (
    <>
      <PageHeader
        title={s.title}
        subtitle={s.subtitle}
        actions={
          <Button asChild>
            <Link href="/admin/templates/new">
              <PlusIcon /> {s.new}
            </Link>
          </Button>
        }
      />
      {templates.length === 0 ? (
        <EmptyState text={s.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{s.name}</TableHead>
              <TableHead>{s.key}</TableHead>
              <TableHead>{s.version}</TableHead>
              <TableHead>{s.owner}</TableHead>
              <TableHead>{s.status}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.map((tpl) => (
              <TableRow key={tpl.id}>
                <TableCell className="font-medium">
                  <Link href={`/admin/templates/${tpl.id}`} className="hover:underline">
                    {tpl.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{tpl.key}</TableCell>
                <TableCell>v{tpl.version}</TableCell>
                <TableCell>
                  <Badge variant={tpl.companyId ? "secondary" : "outline"}>
                    {tpl.companyId ? s.tenant : s.platform}
                  </Badge>
                </TableCell>
                <TableCell>
                  <StatusBadge status={tpl.status} />
                </TableCell>
                <TableCell className="text-muted-foreground text-right text-xs">
                  {formatDate(tpl.updatedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
