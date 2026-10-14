"use client";

import { PlusIcon, ShieldIcon, Trash2Icon, UserCheckIcon, UserRoundXIcon, UsersIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { SelectField, TextField } from "@/components/admin/forms";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { notify } from "@/components/common/notify";
import { DataTable, useTableSelection, type FilterDef, type SortSpec } from "@/components/data/DataTable";
import { RadioField } from "@/components/form/controls";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { User } from "@/lib/api/schemas";
import { formatDate } from "@/lib/utils";

const s = t.admin.users;
const ROLES = ["admin", "member"] as const;
type AssignableRole = (typeof ROLES)[number];

interface Offboarding {
  user: User;
  kind: "disable" | "enable" | "delete";
}

export interface UsersPanelPage {
  page: number;
  limit: number;
  count: number;
  total: number | null;
}

/**
 * The people table: server-paginated through the URL, role filter and search, icon-only row
 * actions (change role, disable or enable, delete) each behind its own confirmation, a bulk
 * "disable" for the selection, and an invite dialog. Nobody can act on themselves or on the
 * platform operator from here; the API refuses it too.
 */
export function UsersPanel({
  users,
  canEdit,
  currentUserId,
  page,
  filters = [],
  sort,
  error,
}: {
  users: User[];
  canEdit: boolean;
  /** The signed-in user: they cannot disable or delete themselves, so no buttons are drawn. */
  currentUserId?: string | undefined;
  page?: UsersPanelPage;
  filters?: FilterDef[];
  sort?: SortSpec;
  error?: string | undefined;
}): React.JSX.Element {
  const router = useRouter();
  const action = useAction();
  const [inviting, setInviting] = React.useState(false);
  const [changing, setChanging] = React.useState<{ user: User; role: AssignableRole } | null>(null);
  const [offboarding, setOffboarding] = React.useState<Offboarding | null>(null);

  const actable = (u: User): boolean => u.id !== currentUserId && u.role !== "platform_operator";

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <Flash flash={action.flash} />
      <DataTable
        id="users"
        label={s.title}
        searchLabel={t.admin.list.searchUsers}
        filters={filters}
        {...(sort ? { sort } : {})}
        {...(error ? { error } : {})}
        selectable={canEdit}
        bulkActions={
          canEdit ? (
            <BulkDisable
              users={users.filter(actable)}
              onDone={() => {
                router.refresh();
              }}
            />
          ) : undefined
        }
        toolbarActions={
          canEdit ? (
            <Button
              onClick={() => {
                setInviting(true);
              }}
            >
              <PlusIcon aria-hidden="true" />
              <span className="max-sm:sr-only">{s.add}</span>
            </Button>
          ) : undefined
        }
        columns={[
          { id: "email", header: s.email, sortKey: "email", primary: true, locked: true },
          { id: "name", header: s.name, sortKey: "name" },
          { id: "role", header: s.role, sortKey: "role" },
          { id: "status", header: s.status },
          {
            id: "created",
            header: t.admin.list.fields.createdAt ?? "Created",
            sortKey: "createdAt",
            defaultHidden: true,
          },
        ]}
        rows={users.map((u) => ({
          id: u.id,
          label: u.email,
          cells: {
            email: (
              <span className="text-foreground font-medium">
                {u.email}
                {u.id === currentUserId ? (
                  <span className="text-muted-foreground ml-2 text-xs font-normal">({s.you})</span>
                ) : null}
              </span>
            ),
            name: u.name ?? t.admin.common.dash,
            role: t.admin.nav.role[u.role],
            status: u.disabledAt ? (
              <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium">
                {s.disabled}
              </span>
            ) : (
              <span className="bg-success-soft text-success-soft-foreground rounded-full px-2 py-0.5 text-xs font-medium">
                {s.active}
              </span>
            ),
            created: <span className="text-muted-foreground">{formatDate(u.createdAt)}</span>,
          },
          actions:
            canEdit && actable(u) ? (
              <RowActions>
                {u.role !== "platform_operator" ? (
                  <IconButton
                    label={`${s.changeRole}: ${u.email}`}
                    icon={<ShieldIcon />}
                    onClick={() => {
                      setChanging({ user: u, role: u.role === "admin" ? "member" : "admin" });
                    }}
                  />
                ) : null}
                <IconButton
                  label={`${u.disabledAt ? s.enable : s.disable}: ${u.email}`}
                  icon={u.disabledAt ? <UserCheckIcon /> : <UserRoundXIcon />}
                  onClick={() => {
                    setOffboarding({ user: u, kind: u.disabledAt ? "enable" : "disable" });
                  }}
                />
                <IconButton
                  label={`${s.delete}: ${u.email}`}
                  icon={<Trash2Icon />}
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    setOffboarding({ user: u, kind: "delete" });
                  }}
                />
              </RowActions>
            ) : undefined,
        }))}
        page={page ?? { page: 1, limit: 50, count: users.length, total: users.length }}
        empty={{
          icon: <UsersIcon className="size-5" aria-hidden="true" />,
          title: s.emptyTitle,
          description: s.empty,
          ...(canEdit
            ? {
                action: (
                  <Button
                    size="sm"
                    onClick={() => {
                      setInviting(true);
                    }}
                  >
                    <PlusIcon aria-hidden="true" /> {s.add}
                  </Button>
                ),
              }
            : {}),
        }}
      />

      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        onInvited={() => {
          router.refresh();
        }}
      />

      <RoleDialog
        target={changing}
        onChange={setChanging}
        onConfirm={(c) => {
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

function InviteDialog({
  open,
  onOpenChange,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvited: () => void;
}): React.JSX.Element {
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<AssignableRole>("member");
  const [touched, setTouched] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setEmail("");
      setName("");
      setRole("member");
      setTouched(false);
      setError(null);
    }
  }, [open]);
  const looksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const emailError = touched && !looksValid ? t.admin.form.invalid : undefined;

  const submit = (): void => {
    setTouched(true);
    if (!looksValid || busy) return;
    setBusy(true);
    setError(null);
    staffClient.users
      .create({ email: email.trim(), ...(name.trim() ? { name: name.trim() } : {}), role })
      .then(() => {
        notify.success(s.added);
        onOpenChange(false);
        onInvited();
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : t.app.unknownError);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t.app.close}>
        <DialogHeader>
          <DialogTitle>{s.add}</DialogTitle>
          <DialogDescription>{s.inviteBody}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <TextField
            id="user-email"
            label={s.email}
            type="email"
            value={email}
            required
            autoComplete="off"
            error={emailError}
            onBlur={() => {
              setTouched(true);
            }}
            onChange={setEmail}
          />
          <TextField id="user-name" label={s.name} value={name} optional onChange={setName} />
          <SelectField
            id="user-role"
            label={s.role}
            value={role}
            options={ROLES.map((r) => ({ value: r, label: t.admin.nav.role[r] }))}
            onChange={setRole}
          />
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              {t.app.cancel}
            </Button>
            <Button type="submit" loading={busy}>
              {s.add}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RoleDialog({
  target,
  onChange,
  onConfirm,
}: {
  target: { user: User; role: AssignableRole } | null;
  onChange: (next: { user: User; role: AssignableRole } | null) => void;
  onConfirm: (target: { user: User; role: AssignableRole }) => void;
}): React.JSX.Element {
  const unchanged = target !== null && target.user.role === target.role;
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onChange(null);
      }}
    >
      <DialogContent closeLabel={t.app.close}>
        <DialogHeader>
          <DialogTitle>{s.roleTitle(target?.user.email ?? "")}</DialogTitle>
          <DialogDescription>
            {target?.role === "admin" ? s.roleBodyGrant : s.roleBodyRevoke}
          </DialogDescription>
        </DialogHeader>
        {target ? (
          <RadioField
            id="role-choice"
            label={s.role}
            value={target.role}
            options={ROLES.map((r) => ({ value: r, label: t.admin.nav.role[r], hint: s.roleHints[r] }))}
            onChange={(role) => {
              onChange({ user: target.user, role });
            }}
          />
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onChange(null);
            }}
          >
            {t.app.cancel}
          </Button>
          <Button
            type="button"
            disabled={unchanged}
            onClick={() => {
              if (target) onConfirm(target);
              onChange(null);
            }}
          >
            {s.roleConfirm(target ? t.admin.nav.role[target.role] : "")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Disable access" for the ticked rows. Rows already disabled are left out; each is one request. */
function BulkDisable({ users, onDone }: { users: User[]; onDone: () => void }): React.JSX.Element {
  const selection = useTableSelection();
  const [confirm, setConfirm] = React.useState(false);
  const chosen = users.filter((u) => selection.ids.includes(u.id) && !u.disabledAt);

  const run = async (): Promise<void> => {
    let failed = 0;
    for (const u of chosen) {
      try {
        await staffClient.users.update(u.id, { disabled: true });
      } catch {
        failed += 1;
      }
    }
    if (failed === 0) notify.success(s.bulkDone(chosen.length));
    else notify.error(s.bulkPartial(chosen.length - failed, failed));
    selection.clear();
    onDone();
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={chosen.length === 0}
        onClick={() => {
          setConfirm(true);
        }}
      >
        <UserRoundXIcon aria-hidden="true" />
        {s.bulkDisable(chosen.length)}
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={s.bulkDisableTitle(chosen.length)}
        description={<p>{s.disableBody}</p>}
        confirmLabel={s.bulkDisable(chosen.length)}
        onConfirm={() => {
          void run();
        }}
      />
    </>
  );
}
