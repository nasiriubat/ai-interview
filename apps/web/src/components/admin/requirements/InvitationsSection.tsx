"use client";

import { BanIcon, SendIcon } from "lucide-react";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { DateText } from "@/components/common/DateText";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { SessionInvitation } from "@/lib/api/schemas";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Invite an external person into the session (contract 18) and manage the invitations sent. */
export function InvitationsSection({
  sessionId,
  initial,
}: {
  sessionId: string;
  initial: SessionInvitation[];
}): React.JSX.Element {
  const s = t.admin.requirements.invitations;
  const action = useAction();
  const rowAction = useAction();
  const [invitations, setInvitations] = React.useState(initial);
  const [email, setEmail] = React.useState("");

  const send = (): void => {
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) {
      action.setFlash({ kind: "error", text: s.invalidEmail });
      return;
    }
    void action.run(async () => {
      const inv = await staffClient.requirements.invitations.create(sessionId, value);
      setInvitations((list) => [inv, ...list.filter((i) => i.id !== inv.id)]);
      setEmail("");
    }, s.sent);
  };

  const revoke = (inv: SessionInvitation): void => {
    void rowAction.run(async () => {
      await staffClient.requirements.invitations.revoke(sessionId, inv.id);
      setInvitations((list) => list.map((i) => (i.id === inv.id ? { ...i, status: "revoked" } : i)));
    }, s.revoked);
  };

  return (
    <section aria-label={s.title} className="grid gap-4">
      <div>
        <h3 className="text-sm font-semibold">{s.title}</h3>
        <p className="text-muted-foreground mt-1 text-sm">{s.body}</p>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="grid min-w-0 flex-1 gap-1.5">
          <Label htmlFor="invite-email">{s.email}</Label>
          <Input
            id="invite-email"
            type="email"
            inputMode="email"
            autoComplete="off"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
        </div>
        <Button type="submit" disabled={action.busy || email.trim().length === 0}>
          <SendIcon /> {s.send}
        </Button>
      </form>
      <Flash flash={action.flash} />
      <Flash flash={rowAction.flash} />
      {invitations.length === 0 ? (
        <p className="text-muted-foreground text-sm">{s.empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{s.email}</TableHead>
                <TableHead>{s.status}</TableHead>
                <TableHead>{s.sentAt}</TableHead>
                <TableHead>{s.expiresAt}</TableHead>
                <TableHead className="text-right">{t.admin.common.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell>{inv.email}</TableCell>
                  <TableCell>
                    <StatusBadge status={inv.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    <DateText iso={inv.sentAt} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    <DateText iso={inv.expiresAt} />
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActions>
                      <IconButton
                        label={`${s.revoke}: ${inv.email}`}
                        icon={<BanIcon />}
                        className="text-destructive hover:text-destructive"
                        disabled={rowAction.busy || inv.status === "revoked"}
                        onClick={() => {
                          revoke(inv);
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
    </section>
  );
}
