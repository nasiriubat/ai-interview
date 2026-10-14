"use client";

import { BellIcon, BanIcon, SendIcon, UploadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { Flash, useAction } from "@/components/admin/Flash";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { DateText } from "@/components/common/DateText";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { Invitation } from "@/lib/api/schemas";

const s = t.admin.campaigns;

/** Above this many addresses a send is a mass email and asks first (the policy table, D-111). */
export const BULK_INVITE_CONFIRM_ABOVE = 50;

/** States in which an invitation can still be answered, and so reminded or revoked. */
const LIVE = new Set(["pending", "sent", "opened"]);

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
  const [confirmBulk, setConfirmBulk] = React.useState(false);
  const [revoking, setRevoking] = React.useState<Invitation | null>(null);
  // Who was reminded in this view: the API stamps `sentAt` again, but only a reload would show it.
  const [reminded, setReminded] = React.useState<ReadonlySet<string>>(new Set());
  const fileInput = React.useRef<HTMLInputElement>(null);

  const requestSend = (): void => {
    if (emails.length === 0) return;
    if (emails.length > BULK_INVITE_CONFIRM_ABOVE) setConfirmBulk(true);
    else send();
  };

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
          requestSend();
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
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              fileInput.current?.click();
            }}
          >
            <UploadIcon aria-hidden="true" /> {s.uploadFile}
          </Button>
          <input
            ref={fileInput}
            id="invite-file"
            type="file"
            accept=".txt,.csv"
            aria-label={s.uploadFileNamed}
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
        <Flash flash={action.flash} />
      </form>

      <Flash flash={rowAction.flash} />
      {invitations.length === 0 ? (
        <EmptyState text={s.noInvitations} />
      ) : (
        <div className="overflow-x-auto">
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
                  <TableCell className="text-muted-foreground text-xs">
                    <DateText iso={inv.sentAt} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    <DateText iso={inv.openedAt} />
                  </TableCell>
                  <TableCell className="text-right">
                    {reminded.has(inv.id) ? (
                      <span role="status" className="text-muted-foreground mr-2 text-xs">
                        {s.reminderSent}
                      </span>
                    ) : null}
                    <RowActions>
                      <IconButton
                        label={`${s.remind}: ${inv.email ?? inv.id}`}
                        icon={<BellIcon />}
                        disabled={rowAction.busy || !LIVE.has(inv.status) || !inv.email}
                        onClick={() => {
                          void rowAction
                            .run(async () => {
                              await staffClient.campaigns.remind(campaignId, inv.id);
                            }, s.reminded)
                            .then((ok) => {
                              if (ok) setReminded((prev) => new Set(prev).add(inv.id));
                            });
                        }}
                      />
                      <IconButton
                        label={`${s.revoke}: ${inv.email ?? inv.id}`}
                        icon={<BanIcon />}
                        className="text-destructive hover:text-destructive"
                        disabled={rowAction.busy || inv.status === "revoked" || inv.status === "bound"}
                        onClick={() => {
                          setRevoking(inv);
                        }}
                      />
                    </RowActions>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <ConfirmDialog
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title={s.bulkTitle(emails.length)}
        description={<p>{s.bulkBody(emails.length)}</p>}
        confirmLabel={s.bulkConfirm(emails.length)}
        tone="default"
        onConfirm={send}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={s.revokeTitle}
        description={<p>{s.revokeBody(revoking?.email ?? s.anonymousEmail)}</p>}
        confirmLabel={s.revokeConfirm}
        onConfirm={() => {
          const inv = revoking;
          if (!inv) return;
          void rowAction.run(async () => {
            await staffClient.campaigns.revoke(campaignId, inv.id);
            router.refresh();
          }, s.revoked);
        }}
      />
    </div>
  );
}
