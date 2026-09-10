"use client";

import { SendIcon, UploadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { Flash, useAction } from "@/components/admin/Flash";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { Invitation } from "@/lib/api/schemas";
import { formatDate } from "@/lib/utils";

const s = t.admin.campaigns;

export function parseEmails(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,;]+/)) {
    const e = raw.trim().toLowerCase();
    if (e.includes("@")) seen.add(e);
  }
  return [...seen];
}

export function InvitationsPanel({
  campaignId,
  invitations,
}: {
  campaignId: string;
  invitations: Invitation[];
}): React.JSX.Element {
  const router = useRouter();
  const action = useAction();
  const rowAction = useAction();
  const [text, setText] = React.useState("");
  const emails = parseEmails(text);

  const send = (): void => {
    if (emails.length === 0) return;
    void action.run(async () => {
      const r = await staffClient.campaigns.invite(campaignId, emails);
      action.setFlash({ kind: "success", text: s.invitationsResult(r.created, r.skipped) });
      setText("");
      router.refresh();
    });
  };

  const onFile = (file: File | undefined): void => {
    if (!file) return;
    file
      .text()
      .then((content) => {
        setText((prev) => (prev ? `${prev}\n${content}` : content));
      })
      .catch(() => undefined);
  };

  return (
    <div className="grid gap-4">
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <p className="text-muted-foreground text-sm">{s.invitationsBody}</p>
        <Label htmlFor="invite-emails" className="sr-only">
          {s.invitationEmail}
        </Label>
        <Textarea
          id="invite-emails"
          value={text}
          rows={4}
          placeholder={s.invitationsPlaceholder}
          onChange={(e) => {
            setText(e.target.value);
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={action.busy || emails.length === 0}>
            <SendIcon /> {s.sendInvitations} {emails.length > 0 ? `(${emails.length})` : ""}
          </Button>
          <Label htmlFor="invite-file" className="cursor-pointer">
            <span className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium">
              <UploadIcon className="size-4" /> {s.uploadFile}
            </span>
            <input
              id="invite-file"
              type="file"
              accept=".txt,.csv"
              className="sr-only"
              onChange={(e) => {
                onFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </Label>
        </div>
        <Flash flash={action.flash} />
      </form>

      <Flash flash={rowAction.flash} />
      {invitations.length === 0 ? (
        <EmptyState text={s.noInvitations} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{s.invitationEmail}</TableHead>
              <TableHead>{s.invitationStatus}</TableHead>
              <TableHead>{s.invitationSent}</TableHead>
              <TableHead>{s.invitationOpened}</TableHead>
              <TableHead className="text-right">{t.admin.common.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invitations.map((inv) => (
              <TableRow key={inv.id}>
                <TableCell>
                  {inv.email ?? <span className="text-muted-foreground">{s.anonymousEmail}</span>}
                </TableCell>
                <TableCell>
                  <StatusBadge status={inv.status} />
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">{formatDate(inv.sentAt)}</TableCell>
                <TableCell className="text-muted-foreground text-xs">{formatDate(inv.openedAt)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={rowAction.busy || inv.status === "revoked" || inv.status === "completed"}
                      onClick={() => {
                        void rowAction.run(async () => {
                          await staffClient.campaigns.remind(campaignId, inv.id);
                        }, s.reminded);
                      }}
                    >
                      {s.remind}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={rowAction.busy || inv.status === "revoked"}
                      onClick={() => {
                        void rowAction.run(async () => {
                          await staffClient.campaigns.revoke(campaignId, inv.id);
                          router.refresh();
                        }, s.revoked);
                      }}
                    >
                      {s.revoke}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
