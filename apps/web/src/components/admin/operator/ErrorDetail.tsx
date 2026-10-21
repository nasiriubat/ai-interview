"use client";

import { CheckIcon, CopyIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { Panel } from "@/components/admin/Panel";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { ErrorGroup, ErrorOccurrence } from "@/lib/api/schemas";
import { cn, formatDate } from "@/lib/utils";

const s = (): typeof t.admin.operator.errors => t.admin.operator.errors;

/**
 * "Mark resolved" and "Delete group" (D-477). Resolving is quiet and reversible by the fault itself
 * (a new occurrence reopens it); deleting asks first, then returns to the list.
 */
export function ErrorActions({ group }: { group: Pick<ErrorGroup, "id" | "status"> }): React.JSX.Element {
  const router = useRouter();
  const action = useAction();
  const [confirming, setConfirming] = React.useState(false);
  const k = s();
  return (
    <>
      {group.status === "open" ? (
        <Button
          variant="outline"
          loading={action.busy && !confirming}
          onClick={() => {
            void action.run(async () => {
              await staffClient.operator.errors.resolve(group.id);
              router.refresh();
            }, k.resolvedDone);
          }}
        >
          <CheckIcon aria-hidden="true" /> {k.resolve}
        </Button>
      ) : null}
      <Button
        variant="outline"
        className="text-destructive hover:text-destructive"
        onClick={() => {
          setConfirming(true);
        }}
      >
        <Trash2Icon aria-hidden="true" /> {k.remove}
      </Button>
      {action.flash ? (
        <div className="basis-full">
          <Flash flash={action.flash} />
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={k.removeTitle}
        description={<p>{k.removeBody}</p>}
        confirmLabel={k.remove}
        onConfirm={() => {
          void action.run(async () => {
            await staffClient.operator.errors.remove(group.id);
            router.push("/admin/operator/errors");
            router.refresh();
          }, k.removedDone);
        }}
      />
    </>
  );
}

/** What "Copy details" puts on the clipboard: the fields a bug report needs, then the stack. */
export function occurrenceText(group: Pick<ErrorGroup, "name" | "message">, o: ErrorOccurrence): string {
  const lines = [
    `${o.name}: ${o.message}`,
    `time: ${o.occurredAt}`,
    o.method || o.status ? `request: ${[o.method, o.path, o.status].filter(Boolean).join(" ")}` : null,
    o.route ? `route: ${o.route}` : null,
    o.requestId ? `request id: ${o.requestId}` : null,
    o.companyId ? `tenant: ${o.companyId}` : null,
    o.userId ? `user: ${o.userId}` : null,
    o.sessionId ? `session: ${o.sessionId}` : null,
    o.jobName
      ? `job: ${o.jobName}${o.jobAttempt ? ` attempt ${o.jobAttempt}` : ""}${o.jobFinal ? " (final)" : ""}`
      : null,
    o.release ? `release: ${o.release}` : null,
    o.userAgent ? `user agent: ${o.userAgent}` : null,
  ].filter((l): l is string => l !== null);
  return `${lines.join("\n")}\n\n${o.stack ?? `${group.name}: ${group.message}`}`;
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => {
              setCopied(false);
            }, 2000);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      <span aria-live="polite">{copied ? s().copied : s().copy}</span>
    </Button>
  );
}

function Field({
  label,
  children,
  mono = true,
  className,
}: {
  label: string;
  children: React.ReactNode;
  /** Ids and paths are read character by character; names and sentences are not. */
  mono?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd
        className={cn(
          "text-body mt-0.5 [overflow-wrap:anywhere]",
          mono ? "font-mono text-xs" : "text-[13px]",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

/** The newest occurrences, each with its ids, its request and its stack (D-477). */
export function OccurrenceList({
  group,
  occurrences,
  tenantName,
}: {
  group: Pick<ErrorGroup, "name" | "message">;
  occurrences: ErrorOccurrence[];
  tenantName: string | null;
}): React.JSX.Element {
  const k = s();
  const f = k.fields;
  return (
    <Panel title={k.occurrences} description={k.occurrencesHint} headingLevel={2}>
      {occurrences.length === 0 ? (
        <p className="text-muted-foreground px-5 py-4 text-sm">{k.noOccurrences}</p>
      ) : (
        <ol className="divide-y">
          {occurrences.map((o) => (
            <li key={o.id} className="grid grid-cols-[minmax(0,1fr)] gap-3 px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <div className="min-w-0 flex-1 basis-64">
                  <p className="text-foreground text-sm font-medium">{formatDate(o.occurredAt)}</p>
                  {o.message !== group.message ? (
                    <p className="text-body mt-0.5 text-sm break-words">{o.message}</p>
                  ) : null}
                </div>
                <CopyButton text={occurrenceText(group, o)} />
              </div>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2 xl:grid-cols-3">
                {o.method || o.status ? (
                  <Field label={f.request}>{[o.method, o.status].filter(Boolean).join(" ")}</Field>
                ) : null}
                {o.path ? <Field label={f.path}>{o.path}</Field> : null}
                {o.requestId ? <Field label={f.requestId}>{o.requestId}</Field> : null}
                <Field label={f.tenant} mono={false}>
                  {o.companyId ? (tenantName ?? o.companyId) : k.platform}
                </Field>
                {o.userId ? <Field label={f.user}>{o.userId}</Field> : null}
                {o.sessionId ? <Field label={f.session}>{o.sessionId}</Field> : null}
                {o.jobName ? (
                  <Field label={f.job}>
                    {o.jobName}
                    {o.jobAttempt ? ` · ${k.attempt(o.jobAttempt)}` : ""}
                    {o.jobFinal === true
                      ? ` · ${k.finalAttempt}`
                      : o.jobFinal === false
                        ? ` · ${k.willRetry}`
                        : ""}
                  </Field>
                ) : null}
                {o.release ? <Field label={f.release}>{o.release}</Field> : null}
                {o.userAgent ? (
                  <Field label={f.userAgent} mono={false} className="sm:col-span-2">
                    {o.userAgent}
                  </Field>
                ) : null}
              </dl>
              {o.stack ? (
                <details data-slot="inset" className="bg-muted/50 group rounded-lg">
                  <summary className="text-foreground hover:bg-muted cursor-pointer rounded-lg px-3 py-2 text-sm font-medium select-none">
                    {k.stack}
                  </summary>
                  <pre className="text-body max-h-96 overflow-auto px-3 pt-1 pb-3 font-mono text-xs leading-relaxed whitespace-pre">
                    {o.stack}
                  </pre>
                </details>
              ) : (
                <p className="text-muted-foreground text-xs">{k.noStack}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
