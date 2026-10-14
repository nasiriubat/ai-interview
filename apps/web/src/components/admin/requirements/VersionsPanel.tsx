"use client";

import { Loader2Icon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { InvitationsSection } from "./InvitationsSection";
import { EmptyState } from "@/components/admin/EmptyState";
import { Flash, useAction } from "@/components/admin/Flash";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { DateText } from "@/components/common/DateText";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isPendingVersion, useSpecVersions } from "@/hooks/useSpecVersions";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import { isApiError } from "@/lib/api/errors";
import type { SessionInvitation, SpecVersionSummary } from "@/lib/api/schemas";

/** The Versions tab: generate a version, the version table (polled while pending), invitations. */
export function VersionsPanel({
  sessionId,
  initialVersions,
  initialInvitations,
}: {
  sessionId: string;
  initialVersions: SpecVersionSummary[];
  initialInvitations: SessionInvitation[];
}): React.JSX.Element {
  const s = t.admin.requirements.versions;
  const action = useAction();
  const router = useRouter();
  const [versions, setVersions] = useSpecVersions(sessionId, initialVersions);
  const [label, setLabel] = React.useState("");
  const pending = versions.some(isPendingVersion);

  const generate = (): void => {
    void action.run(async () => {
      try {
        const created = await staffClient.requirements.versions.create(sessionId, label.trim() || undefined);
        setVersions((list) => [created, ...list.filter((v) => v.id !== created.id)]);
        setLabel("");
      } catch (e) {
        if (isApiError(e) && e.status === 409) throw new Error(s.alreadyRunning);
        throw e;
      }
    }, s.queued);
  };

  return (
    <div className="grid gap-8">
      <section aria-label={s.title} className="grid gap-4">
        <p className="text-muted-foreground text-sm">{s.body}</p>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            generate();
          }}
        >
          <div className="grid min-w-0 flex-1 gap-1.5">
            <Label htmlFor="version-label">{s.label}</Label>
            <Input
              id="version-label"
              value={label}
              maxLength={80}
              placeholder={s.labelPlaceholder}
              onChange={(e) => {
                setLabel(e.target.value);
              }}
            />
          </div>
          <Button type="submit" disabled={action.busy || pending} aria-busy={action.busy}>
            {action.busy || pending ? (
              <Loader2Icon className="animate-spin motion-reduce:animate-none" />
            ) : (
              <SparklesIcon />
            )}
            {action.busy ? s.generating : s.generate}
          </Button>
        </form>
        {pending ? (
          <p className="text-muted-foreground text-xs" role="status">
            {s.polling}
          </p>
        ) : null}
        <Flash flash={action.flash} />
        {versions.length === 0 ? (
          <EmptyState text={s.empty} />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{s.columns.version}</TableHead>
                  <TableHead>{s.columns.label}</TableHead>
                  <TableHead>{s.columns.status}</TableHead>
                  <TableHead>{s.columns.created}</TableHead>
                  <TableHead className="text-right">{s.columns.requirements}</TableHead>
                  <TableHead className="text-right">{s.columns.mvp}</TableHead>
                  <TableHead className="text-right">{s.columns.future}</TableHead>
                  <TableHead className="text-right">{s.columns.phases}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.map((v) => (
                  <TableRow
                    key={v.id}
                    // The whole row opens the version; the link in the first cell stays for the
                    // keyboard and screen readers.
                    className="hover:bg-muted/60 cursor-pointer"
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("a,button")) return;
                      router.push(`/admin/requirements/${sessionId}/versions/${String(v.version)}`);
                    }}
                  >
                    <TableCell className="font-medium">
                      <Link
                        href={`/admin/requirements/${sessionId}/versions/${v.version}`}
                        className="hover:underline"
                      >
                        v{v.version}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-48 truncate">{v.label ?? t.admin.common.dash}</TableCell>
                    <TableCell>
                      <StatusBadge status={v.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      <DateText iso={v.createdAt} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{v.stats.requirements}</TableCell>
                    <TableCell className="text-right tabular-nums">{v.stats.mvp}</TableCell>
                    <TableCell className="text-right tabular-nums">{v.stats.future}</TableCell>
                    <TableCell className="text-right tabular-nums">{v.stats.phases}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      <InvitationsSection sessionId={sessionId} initial={initialInvitations} />
    </div>
  );
}
