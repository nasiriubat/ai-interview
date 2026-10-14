"use client";

import { PROVIDER_KINDS } from "@aidp/shared";
import { ListIcon, PlusIcon, Trash2Icon, ZapIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { Flash, useAction } from "@/components/admin/Flash";
import { SelectField, SwitchField, TextAreaField, TextField } from "@/components/admin/forms";
import { IconButton, IconTooltip, RowActions } from "@/components/admin/IconButton";
import { EnumLabel } from "@/components/common/EnumLabel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
}: {
  providers: Provider[];
  scope: ProviderScope;
}): React.JSX.Element {
  const router = useRouter();
  const api = providersApiFor(scope);
  const action = useAction();
  const [tests, setTests] = React.useState<Record<string, ProviderTest | "running">>({});
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
          toast.success(s.testToast(name, r.model ?? "", r.latencyMs ?? 0));
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
    <div className="grid gap-4">
      <div className="flex justify-end">
        <AddProviderDialog scope={scope} />
      </div>
      <Flash flash={action.flash} />
      {providers.length === 0 ? (
        <EmptyState text={s.empty} />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{s.name}</TableHead>
                <TableHead>{s.kind}</TableHead>
                <TableHead>{s.level}</TableHead>
                <TableHead>{s.apiKey}</TableHead>
                <TableHead>{s.enabled}</TableHead>
                <TableHead>{s.test}</TableHead>
                <TableHead className="text-right">{t.admin.common.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map((p) => {
                const tr = tests[p.id];
                return (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">
                      <Link href={`${base}/${p.id}`} className="hover:underline">
                        {p.name}
                      </Link>
                      {p.baseUrl ? (
                        <p className="text-muted-foreground font-mono text-xs">{p.baseUrl}</p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        <EnumLabel kind="providerKind" value={p.kind} />
                      </Badge>
                    </TableCell>
                    <TableCell>{p.companyId ? s.tenantLevel : s.platformLevel}</TableCell>
                    <TableCell>
                      {p.kind === "local" ? (
                        // Whisper on this server has no key to set (D-75); "No key" would read as a fault.
                        <Badge variant="outline">{s.keyNotNeeded}</Badge>
                      ) : (
                        <Badge variant={p.hasKey ? "success" : "warning"}>
                          {p.hasKey ? s.hasKey : s.noKey}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
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
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <IconButton
                          label={tr === "running" ? s.testing : `${s.test}: ${p.name}`}
                          icon={<ZapIcon />}
                          variant="outline"
                          disabled={tr === "running"}
                          onClick={() => {
                            test(p.id);
                          }}
                        />
                        {tr === "running" ? (
                          <span role="status" className="text-muted-foreground text-xs">
                            {s.testing}
                          </span>
                        ) : null}
                        {tr && tr !== "running" ? (
                          <span
                            className={
                              tr.ok ? "text-success-soft-foreground text-xs" : "text-destructive text-xs"
                            }
                            role="status"
                          >
                            {tr.ok
                              ? [
                                  s.testResult(
                                    tr.latencyMs ?? 0,
                                    tr.tokens ?? 0,
                                    formatCents(tr.costCents ?? 0),
                                  ),
                                  tr.model ? s.testModel(tr.model) : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")
                              : s.testFailed(tr.error ?? t.app.unknownError)}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <RowActions>
                        <IconButton label={s.models} icon={<ListIcon />} href={`${base}/${p.id}`} />
                        <AlertDialog>
                          <IconTooltip label={`${s.delete}: ${p.name}`}>
                            <AlertDialogTrigger asChild>
                              <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                className="text-destructive hover:text-destructive"
                                aria-label={`${s.delete}: ${p.name}`}
                              >
                                <Trash2Icon aria-hidden="true" />
                              </Button>
                            </AlertDialogTrigger>
                          </IconTooltip>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>{s.delete}</AlertDialogTitle>
                              <AlertDialogDescription>{s.deleteConfirm}</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>{t.app.cancel}</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => {
                                  void action.run(async () => {
                                    await api.remove(p.id);
                                    router.refresh();
                                  }, s.deleted);
                                }}
                              >
                                {t.app.delete}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </RowActions>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function AddProviderDialog({ scope }: { scope: ProviderScope }): React.JSX.Element {
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
            <TextField
              id="apiKey"
              label={s.apiKey}
              value={apiKey}
              type="password"
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
