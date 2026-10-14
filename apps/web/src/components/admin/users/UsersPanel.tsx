"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { Flash, useAction } from "@/components/admin/Flash";
import { SelectField, TextField } from "@/components/admin/forms";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { User } from "@/lib/api/schemas";

const s = t.admin.users;
const ROLES = ["admin", "member"] as const;

type Offboarding = { user: User; kind: "disable" | "enable" | "delete" };

export function UsersPanel({
  users,
  canEdit,
  currentUserId,
}: {
  users: User[];
  canEdit: boolean;
  /** The signed-in user: they cannot disable or delete themselves, so no buttons are drawn. */
  currentUserId?: string | undefined;
}): React.JSX.Element {
  const router = useRouter();
  const action = useAction();
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<(typeof ROLES)[number]>("member");
  const [changing, setChanging] = React.useState<{ user: User; role: (typeof ROLES)[number] } | null>(null);
  const [offboarding, setOffboarding] = React.useState<Offboarding | null>(null);

  return (
    <div className="grid gap-6">
      {canEdit ? (
        <form
          className="grid gap-3 bg-card shadow-card rounded-lg p-4 md:grid-cols-[1fr_1fr_10rem_auto] md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await staffClient.users.create({
                email: email.trim(),
                ...(name.trim() ? { name: name.trim() } : {}),
                role,
              });
              setEmail("");
              setName("");
              router.refresh();
            }, s.added);
          }}
        >
          <TextField
            id="user-email"
            label={s.email}
            type="email"
            value={email}
            required
            onChange={setEmail}
          />
          <TextField id="user-name" label={s.name} value={name} onChange={setName} />
          <SelectField
            id="user-role"
            label={s.role}
            value={role}
            required
            options={ROLES.map((r) => ({ value: r, label: t.admin.nav.role[r] }))}
            onChange={setRole}
          />
          <Button type="submit" disabled={action.busy || !email.trim()}>
            <PlusIcon /> {s.add}
          </Button>
        </form>
      ) : null}
      <Flash flash={action.flash} />
      {users.length === 0 ? (
        <EmptyState text={s.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{s.email}</TableHead>
              <TableHead>{s.name}</TableHead>
              <TableHead>{s.role}</TableHead>
              <TableHead>{s.status}</TableHead>
              {canEdit ? <TableHead>{s.actions}</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell>{u.email}</TableCell>
                <TableCell>{u.name ?? t.admin.common.dash}</TableCell>
                <TableCell>
                  {canEdit && u.role !== "platform_operator" ? (
                    <Select
                      value={u.role}
                      onValueChange={(v) => {
                        // The select stays on the saved role until the change is confirmed: a role
                        // is a security decision, never a stray click on a dropdown.
                        const next = ROLES.find((r) => r === v);
                        if (next && next !== u.role) setChanging({ user: u, role: next });
                      }}
                    >
                      <SelectTrigger size="sm" className="w-36" aria-label={`${s.role}: ${u.email}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.map((r) => (
                          <SelectItem key={r} value={r}>
                            {t.admin.nav.role[r]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    t.admin.nav.role[u.role]
                  )}
                </TableCell>
                <TableCell>{u.disabledAt ? s.disabled : s.active}</TableCell>
                {canEdit ? (
                  <TableCell>
                    {u.id === currentUserId ? (
                      <span className="text-muted-foreground text-sm">{s.you}</span>
                    ) : (
                      <div className="flex flex-wrap gap-2" role="group" aria-label={s.rowActions(u.email)}>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setOffboarding({ user: u, kind: u.disabledAt ? "enable" : "disable" })
                          }
                        >
                          {u.disabledAt ? s.enable : s.disable}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setOffboarding({ user: u, kind: "delete" })}
                        >
                          {s.delete}
                        </Button>
                      </div>
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={changing !== null}
        onOpenChange={(open) => {
          if (!open) setChanging(null);
        }}
        title={s.roleTitle(changing?.user.email ?? "")}
        description={<p>{changing?.role === "admin" ? s.roleBodyGrant : s.roleBodyRevoke}</p>}
        confirmLabel={s.roleConfirm(changing ? t.admin.nav.role[changing.role] : "")}
        tone="default"
        onConfirm={() => {
          const c = changing;
          if (!c) return;
          void action.run(async () => {
            await staffClient.users.update(c.user.id, { role: c.role });
            router.refresh();
          }, s.updated);
        }}
      />
      <ConfirmDialog
        open={offboarding !== null}
        onOpenChange={(open) => {
          if (!open) setOffboarding(null);
        }}
        title={
          offboarding?.kind === "delete"
            ? s.deleteTitle(offboarding.user.email)
            : offboarding?.kind === "enable"
              ? s.enableTitle(offboarding.user.email)
              : s.disableTitle(offboarding?.user.email ?? "")
        }
        description={
          <p>
            {offboarding?.kind === "delete"
              ? s.deleteBody
              : offboarding?.kind === "enable"
                ? s.enableBody
                : s.disableBody}
          </p>
        }
        confirmLabel={
          offboarding?.kind === "delete"
            ? s.deleteConfirm
            : offboarding?.kind === "enable"
              ? s.enableConfirm
              : s.disableConfirm
        }
        tone={offboarding?.kind === "enable" ? "default" : "destructive"}
        onConfirm={() => {
          const o = offboarding;
          if (!o) return;
          void action.run(
            async () => {
              if (o.kind === "delete") await staffClient.users.remove(o.user.id);
              else await staffClient.users.update(o.user.id, { disabled: o.kind === "disable" });
              router.refresh();
            },
            o.kind === "delete" ? s.deletedDone : o.kind === "enable" ? s.enabledDone : s.disabledDone,
          );
        }}
      />
    </div>
  );
}
