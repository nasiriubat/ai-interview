"use client";

import { PROVIDER_KINDS } from "@aidp/shared";
import {
  CheckCircle2Icon,
  ListIcon,
  Loader2Icon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
  XCircleIcon,
  ZapIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { SelectField, SwitchField, TextAreaField, TextField } from "@/components/admin/forms";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { EnumLabel } from "@/components/common/EnumLabel";
import { notify } from "@/components/common/notify";
import { DataTable } from "@/components/data/DataTable";
import { SecretField } from "@/components/form/controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { Provider, ProviderTest } from "@/lib/api/schemas";
import type { ProvidersApi } from "@/lib/api/staff";
import { label as enumLabel } from "@/lib/i18n/enums";
import { formatCents } from "@/lib/utils";

const s = t.admin.providers;
export type ProviderScope = "tenant" | "platform";

export function providersApiFor(scope: ProviderScope): ProvidersApi {
  return scope === "platform" ? staffClient.operator.providers : staffClient.providers;
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

export function ProvidersPanel({
  providers,
  scope,
  error,
}: {
  providers: Provider[];
  scope: ProviderScope;
  error?: string | undefined;
}): React.JSX.Element {
  const router = useRouter();
  const api = providersApiFor(scope);
  const action = useAction();
  const [tests, setTests] = React.useState<Record<string, ProviderTest | "running">>({});
  const [deleting, setDeleting] = React.useState<Provider | null>(null);
  const base = scope === "platform" ? "/admin/operator/providers" : "/admin/providers";

  const test = (id: string): void => {
    setTests((prev) => ({ ...prev, [id]: "running" }));
    api
      .test(id)
      .then((r) => {
        setTests((prev) => ({ ...prev, [id]: r }));
        // The result stays next to its row (D-78); a success is also said once, in a toast, because
        // the cell may be off screen on a phone. A failure is only inline: it has to be read.
        if (r.ok) {
          const name = providers.find((pr) => pr.id === id)?.name ?? id;
          notify.success(s.testToast(name, r.model ?? "", r.latencyMs ?? 0));
        }
      })
      .catch((e: unknown) => {
        setTests((prev) => ({
          ...prev,
          [id]: { ok: false, error: e instanceof Error ? e.message : t.app.unknownError },
        }));
      });
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <Flash flash={action.flash} />
      <DataTable
        id={`providers-${scope}`}
        label={s.title}
        error={error}
        columns={[
          { id: "name", header: s.name, primary: true, locked: true },
          { id: "kind", header: s.kind },
          { id: "level", header: s.level, defaultHidden: scope === "tenant" },
          { id: "key", header: s.apiKey },
          { id: "enabled", header: s.enabled },
          { id: "test", header: t.ws.providers.connection },
        ]}
        rows={providers.map((p) => {
          const tr = tests[p.id];
          return {
            id: p.id,
            label: p.name,
            cells: {
              name: (
                <div className="min-w-0">
                  <Link href={`${base}/${p.id}`} className="text-foreground font-medium hover:underline">
                    {p.name}
                  </Link>
                  {p.baseUrl ? (
                    <p className="text-muted-foreground font-mono text-xs break-all">{p.baseUrl}</p>
                  ) : null}
                </div>
              ),
              kind: (
                <Badge variant="outline" className="max-w-56 text-left whitespace-normal">
                  <EnumLabel kind="providerKind" value={p.kind} />
                </Badge>
              ),
              level: (
                <span className="text-muted-foreground">{p.companyId ? s.tenantLevel : s.platformLevel}</span>
              ),
              key:
                p.kind === "local" ? (
                  // Whisper on this server has no key to set (D-75); "No key" would read as a fault.
                  <Badge variant="outline">{t.ws.providers.keyNotNeeded}</Badge>
                ) : (
                  <Badge variant={p.hasKey ? "success" : "warning"}>{p.hasKey ? s.hasKey : s.noKey}</Badge>
                ),
              enabled: (
                <Switch
                  checked={p.enabled}
                  aria-label={`${s.enabled}: ${p.name}`}
                  disabled={action.busy || (p.companyId === null && scope === "tenant")}
                  onCheckedChange={(v) => {
                    void action.run(async () => {
                      await api.update(p.id, { enabled: v });
                      router.refresh();
                    }, s.updated);
                  }}
                />
              ),
              test:
                tr === "running" ? (
                  <span role="status" className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <Loader2Icon
                      className="size-3.5 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    {s.testing}
                  </span>
                ) : tr ? (
                  <span
                    role="status"
                    className={
                      tr.ok
                        ? "text-success-soft-foreground flex items-start gap-1.5 text-xs"
                        : "text-destructive flex items-start gap-1.5 text-xs"
                    }
                  >
                    {tr.ok ? (
                      <CheckCircle2Icon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <XCircleIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                    )}
                    {tr.ok
                      ? [
                          s.testResult(tr.latencyMs ?? 0, tr.tokens ?? 0, formatCents(tr.costCents ?? 0)),
                          tr.model ? s.testModel(tr.model) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : s.testFailed(tr.error ?? t.app.unknownError)}
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">{t.ws.providers.notTested}</span>
                ),
            },
            actions: (
              <RowActions>
                <IconButton
                  label={tr === "running" ? s.testing : `${s.test}: ${p.name}`}
                  icon={<ZapIcon />}
                  disabled={tr === "running"}
                  onClick={() => {
                    test(p.id);
                  }}
                />
                <IconButton label={`${s.models}: ${p.name}`} icon={<ListIcon />} href={`${base}/${p.id}`} />
                <IconButton
                  label={`${s.delete}: ${p.name}`}
                  icon={<Trash2Icon />}
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    setDeleting(p);
                  }}
                />
              </RowActions>
            ),
          };
        })}
        page={{ page: 1, limit: 200, count: providers.length, total: providers.length }}
        empty={{
          icon: <ServerIcon className="size-5" aria-hidden="true" />,
          title: t.ws.providers.emptyTitle,
          description: s.empty,
          action: <AddProviderDialog scope={scope} />,
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t.ws.providers.deleteTitle(deleting?.name ?? "")}
        description={<p>{s.deleteConfirm}</p>}
        confirmLabel={t.app.delete}
        onConfirm={() => {
          const p = deleting;
          if (!p) return;
          void action.run(async () => {
            await api.remove(p.id);
            router.refresh();
          }, s.deleted);
        }}
      />
    </div>
  );
}

export function AddProviderDialog({ scope }: { scope: ProviderScope }): React.JSX.Element {
  const router = useRouter();
  const api = providersApiFor(scope);
  const action = useAction();
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<(typeof PROVIDER_KINDS)[number]>("anthropic");
  const [name, setName] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [headers, setHeaders] = React.useState("");
  const [enabled, setEnabled] = React.useState(true);

  const submit = (): void => {
    void action.run(async () => {
      await api.create({
        kind,
        name: name.trim(),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(apiKey && kind !== "local" ? { apiKey } : {}),
        ...(headers.trim() ? { headers: parseHeaders(headers) } : {}),
        enabled,
      });
      setOpen(false);
      setName("");
      setApiKey("");
      router.refresh();
    }, s.created);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon /> {s.add}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={t.app.close}>
        <DialogHeader>
          <DialogTitle>{s.add}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Flash flash={action.flash} />
          <SelectField
            id="kind"
            label={s.kind}
            value={kind}
            required
            options={PROVIDER_KINDS.map((k) => ({ value: k, label: enumLabel("providerKind", k) }))}
            onChange={setKind}
          />
          <TextField id="pname" label={s.name} value={name} required onChange={setName} />
          <TextField
            id="baseUrl"
            label={s.baseUrl}
            value={baseUrl}
            type="url"
            placeholder="https://"
            hint={s.baseUrlHint}
            onChange={setBaseUrl}
          />
          {kind === "local" ? null : (
            <SecretField
              id="apiKey"
              label={s.apiKey}
              value={apiKey}
              hint={s.apiKeyHint}
              onChange={setApiKey}
            />
          )}
          <TextAreaField id="headers" label={s.headers} value={headers} rows={2} onChange={setHeaders} />
          <SwitchField id="enabled" label={s.enabled} checked={enabled} onChange={setEnabled} />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setOpen(false);
              }}
            >
              {t.app.cancel}
            </Button>
            <Button type="submit" disabled={action.busy || !name.trim()}>
              {action.busy ? t.app.saving : t.app.add}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
