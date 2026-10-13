"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { Flash, useAction } from "@/components/admin/Flash";
import { SelectField, TextField } from "@/components/admin/forms";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { User } from "@/lib/api/schemas";

const s = t.admin.users;
const ROLES = ["admin", "member"] as const;

export function UsersPanel({ users, canEdit }: { users: User[]; canEdit: boolean }): React.JSX.Element {
  const router = useRouter();
  const action = useAction();
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<(typeof ROLES)[number]>("member");

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
                        void action.run(async () => {
                          await staffClient.users.update(u.id, { role: v });
                          router.refresh();
                        }, s.updated);
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
