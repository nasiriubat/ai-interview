"use client";

import {
  CheckIcon,
  CircleSlashIcon,
  FlaskConicalIcon,
  GitCompareIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { Field, SelectField } from "@/components/admin/forms";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { Panel, SectionTitle } from "@/components/admin/Panel";
import { PromptDiff } from "@/components/admin/prompts/PromptDiff";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { useDirty } from "@/components/common/DirtyGuard";
import { DataTable } from "@/components/data/DataTable";
import { SaveBarView } from "@/components/form/Form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Inset } from "@/components/ui/inset";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { actorLabel } from "@/lib/admin/actor";
import { countChanges, diffLines } from "@/lib/admin/lineDiff";
import { checkLines } from "@/lib/admin/promptIssues";
import { staffClient } from "@/lib/api/browser";
import type { PromptCheck, PromptDetail, PromptVersion } from "@/lib/api/schemas";
import { formatDate, formatPercent, formatDuration } from "@/lib/utils";

type Base = "shipped" | number;
type CheckState = { state: "pending" } | { state: "failed" } | { state: "done"; check: PromptCheck };

const CHECK_DELAY_MS = 400;

/** Bodies the editor and the comparison can start from. */
function bodyOf(detail: PromptDetail, ref: Base): string {
  if (ref === "shipped") return detail.shipped.body;
  return detail.versions.find((v) => v.version === ref)?.body ?? detail.shipped.body;
}

/** The version a new draft starts from: the one in use, or the built-in prompt. */
function initialBase(detail: PromptDetail): Base {
  const stable = detail.versions.find((v) => v.state === "stable");
  return stable ? stable.version : "shipped";
}

/**
 * The editing surface of one prompt (D-233 to D-235): what is in use, the editor with its live
 * checks, a comparison, and the history with the controls that change what participants get.
 * Saving never changes what participants get; using a version is a separate, explicit step.
 */
export function PromptWorkspace({ detail }: { detail: PromptDetail }): React.JSX.Element {
  const s = t.admin.prompts;
  const d = s.detail;
  const router = useRouter();
  const action = useAction();
  const key = detail.key;

  const [base, setBase] = React.useState<Base>(() => initialBase(detail));
  const [body, setBody] = React.useState<string>(() => bodyOf(detail, initialBase(detail)));
  const [note, setNote] = React.useState("");
  const [check, setCheck] = React.useState<CheckState>({ state: "pending" });
  const [using, setUsing] = React.useState<PromptVersion | null>(null);
  const [confirm, setConfirm] = React.useState<"stop" | "rollback" | "reset" | null>(null);
  const [left, setLeft] = React.useState<Base | "draft">("shipped");
  const [right, setRight] = React.useState<Base | "draft">("draft");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const diffHeadingRef = React.useRef<HTMLHeadingElement>(null);

  const baseBody = bodyOf(detail, base);
  const dirty = body !== baseBody;
  useDirty(`prompt-${key}`, dirty);

  // The checks run on the server, which is the one place the contract lives. A counter drops the
  // answer of a request that a later keystroke has already replaced.
  const requestId = React.useRef(0);
  React.useEffect(() => {
    const id = ++requestId.current;
    setCheck({ state: "pending" });
    const timer = window.setTimeout(() => {
      staffClient.prompts
        .check(key, body)
        .then((result) => {
          if (id === requestId.current) setCheck({ state: "done", check: result });
        })
        .catch(() => {
          if (id === requestId.current) setCheck({ state: "failed" });
        });
    }, CHECK_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [key, body]);

  const lines = check.state === "done" ? checkLines(check.check, detail.contract.maxChars) : [];
  const failing = lines.filter((l) => !l.ok).length;
  const passed = check.state === "done" && check.check.ok;

  const stable = detail.versions.find((v) => v.state === "stable");
  const canary = detail.versions.find((v) => v.state === "canary");
  const canRollBack = detail.versions.some(
    (v) => v.state === "inactive" && v.canaryShare >= 1 && v.deactivatedAt != null,
  );
  const usesOwn = stable !== undefined || canary !== undefined;

  const startFrom = (ref: Base): void => {
    setBase(ref);
    setBody(bodyOf(detail, ref));
  };

  const save = (): void => {
    void action.run(async () => {
      const saved = await staffClient.prompts.create(key, {
        body,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(base !== "shipped" ? { parentVersion: base } : {}),
      });
      setNote("");
      setBase(saved.version);
      router.refresh();
      action.setFlash({ kind: "success", text: d.saved(saved.version) });
    });
  };

  const serving = ((): string => {
    if (detail.effective.source === "tenant") return d.servingYours(detail.effective.version);
    if (detail.effective.source === "platform") return d.servingPlatform(detail.effective.version);
    return d.servingShipped(detail.effective.version);
  })();

  const diffOptions: { value: string; label: string }[] = [
    { value: "shipped", label: d.diffShipped },
    ...detail.versions.map((v) => ({ value: String(v.version), label: d.diffVersion(v.version) })),
    { value: "draft", label: d.diffDraft },
  ];
  const resolve = (ref: Base | "draft"): string => (ref === "draft" ? body : bodyOf(detail, ref));
  const parse = (value: string): Base | "draft" =>
    value === "shipped" || value === "draft" ? value : Number(value);
  const diff = diffLines(resolve(left), resolve(right));
  const changes = countChanges(diff);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <Alert variant="warning" role="status">
        <FlaskConicalIcon aria-hidden="true" />
        <AlertTitle>{s.warningTitle}</AlertTitle>
        <AlertDescription>
          <p>{s.warningBody}</p>
          <p>
            {usesOwn ? s.evalsYours : s.evalsBuiltIn} {s.evalsDocPrefix} <code>{s.evalsDoc}</code>{" "}
            {s.evalsDocSuffix}
          </p>
        </AlertDescription>
      </Alert>

      <Panel
        title={d.servingTitle}
        description={s.windowNote(detail.windowDays)}
        actions={
          <>
            {canary ? (
              <IconButton
                label={d.stopCanary}
                variant="outline"
                size="icon"
                icon={<CircleSlashIcon />}
                disabled={action.busy}
                onClick={() => {
                  setConfirm("stop");
                }}
              />
            ) : null}
            <IconButton
              label={d.rollBack}
              variant="outline"
              size="icon"
              icon={<Undo2Icon />}
              disabled={action.busy || !canRollBack}
              onClick={() => {
                setConfirm("rollback");
              }}
            />
            <IconButton
              label={d.reset}
              variant="outline"
              size="icon"
              icon={<RotateCcwIcon />}
              disabled={action.busy || !usesOwn}
              onClick={() => {
                setConfirm("reset");
              }}
            />
          </>
        }
      >
        <div className="grid gap-2 px-5 py-4 text-sm">
          <p>
            <Badge variant={detail.effective.source === "tenant" ? "default" : "secondary"}>
              {s.source[detail.effective.source]}
            </Badge>{" "}
            <code className="font-mono text-xs">{detail.effective.tag}</code>
          </p>
          <p>{serving}</p>
          <p>{canary ? d.canaryRunning(canary.version, Math.round(canary.canaryShare * 100)) : d.noCanary}</p>
          {detail.platform && detail.effective.source !== "platform" ? (
            <p className="text-muted-foreground">{d.platformNote(detail.platform.version)}</p>
          ) : null}
          <Flash flash={action.flash} />
        </div>
      </Panel>

      <form
        noValidate
        className="grid grid-cols-[minmax(0,1fr)] gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (passed && dirty && !action.busy) save();
        }}
      >
        <Panel title={d.editorTitle} description={d.editorHint}>
          <div className="grid gap-4 px-5 py-4">
            <SelectField
              id="prompt-start"
              label={d.startFrom}
              value={String(base)}
              className="max-w-xs"
              options={[
                { value: "shipped", label: d.startFromShipped },
                ...detail.versions.map((v) => ({
                  value: String(v.version),
                  label: d.startFromVersion(v.version),
                })),
              ]}
              onChange={(v) => {
                startFrom(v === "shipped" ? "shipped" : Number(v));
              }}
            />
            <Field
              id="prompt-body"
              label={d.bodyLabel}
              hint={d.characters(body.length, detail.contract.maxChars)}
            >
              <Textarea
                id="prompt-body"
                ref={textareaRef}
                value={body}
                rows={22}
                spellCheck={false}
                autoComplete="off"
                className="min-h-72 font-mono text-xs leading-5"
                aria-describedby="prompt-body-hint prompt-checks"
                aria-invalid={check.state === "done" && !check.check.ok ? true : undefined}
                onChange={(e) => {
                  setBody(e.target.value);
                }}
              />
            </Field>

            <div id="prompt-checks" className="grid gap-2">
              <h3 className="text-foreground text-sm font-medium">{d.checksTitle}</h3>
              <p role="status" className="text-sm">
                {check.state === "pending"
                  ? d.checking
                  : check.state === "failed"
                    ? d.checkUnavailable
                    : passed
                      ? d.checkPassed
                      : d.checkFailed(failing)}
              </p>
              {lines.length > 0 ? (
                <ul className="grid gap-1.5">
                  {lines.map((l) => (
                    <li key={l.id} className="flex items-start gap-2 text-sm">
                      {l.ok ? (
                        <CheckIcon className="text-success mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      ) : (
                        <XIcon className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      )}
                      <span>
                        <span className="sr-only">{l.ok ? d.checkPassedLabel : d.checkFailedLabel}: </span>
                        {l.text}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <Field id="prompt-note" label={d.noteLabel} hint={d.noteHint}>
              <Input
                id="prompt-note"
                value={note}
                maxLength={500}
                placeholder={d.notePlaceholder}
                aria-describedby="prompt-note-hint"
                onChange={(e) => {
                  setNote(e.target.value);
                }}
              />
            </Field>
          </div>
        </Panel>
        <SaveBarView
          dirty={dirty}
          submitting={action.busy}
          saveDisabled={!passed}
          onDiscard={() => {
            startFrom(base);
          }}
          saveLabel={d.save}
          cleanText={d.unchanged}
        />
      </form>

      <Panel title={d.contractTitle}>
        <div className="grid gap-3 px-5 py-4 text-sm">
          <Inset>
            <p className="font-medium">{d.contractPlaceholders}</p>
            <p className="mt-1 flex flex-wrap gap-1.5">
              {detail.contract.requiredPlaceholders.length === 0 ? (
                <span className="text-muted-foreground">{t.admin.common.dash}</span>
              ) : (
                detail.contract.requiredPlaceholders.map((p) => (
                  <code
                    key={p}
                    className="bg-card rounded px-1.5 py-0.5 font-mono text-xs"
                  >{`{{${p}}}`}</code>
                ))
              )}
            </p>
          </Inset>
          {detail.contract.untrustedRules ? (
            <Inset>
              <p>{d.contractUntrusted}</p>
            </Inset>
          ) : null}
          {detail.contract.contractTokens.length > 0 ? (
            <Inset>
              <p className="font-medium">{d.contractTokens}</p>
              <p className="mt-1 flex flex-wrap gap-1.5">
                {detail.contract.contractTokens.map((tok) => (
                  <code key={tok} className="bg-card rounded px-1.5 py-0.5 font-mono text-xs">
                    {tok}
                  </code>
                ))}
              </p>
            </Inset>
          ) : null}
        </div>
      </Panel>

      <Panel title={d.diffTitle}>
        <div className="grid gap-3 px-5 py-4">
          <h3 ref={diffHeadingRef} tabIndex={-1} className="sr-only">
            {d.diffTitle}
          </h3>
          <div className="flex flex-wrap items-end gap-3">
            <SelectField
              id="diff-left"
              label={d.diffAgainst}
              value={String(left)}
              options={diffOptions}
              className="min-w-44"
              onChange={(v) => {
                setLeft(parse(v));
              }}
            />
            <span aria-hidden="true" className="text-muted-foreground pb-2">
              →
            </span>
            <SelectField
              id="diff-right"
              label={d.diffTitle}
              value={String(right)}
              options={diffOptions}
              className="min-w-44"
              onChange={(v) => {
                setRight(parse(v));
              }}
            />
          </div>
          <p className="text-muted-foreground text-sm" role="status">
            {d.diffSummary(changes.added, changes.removed)}
          </p>
          <PromptDiff lines={diff} />
        </div>
      </Panel>

      <section aria-labelledby="prompt-versions" className="grid grid-cols-[minmax(0,1fr)] gap-3">
        <SectionTitle id="prompt-versions">{d.versionsTitle}</SectionTitle>
        <DataTable
          id={`prompt-versions-${key}`}
          label={d.versionsTitle}
          columns={[
            { id: "version", header: d.versionsColumns.version, primary: true, locked: true },
            { id: "state", header: d.versionsColumns.state, locked: true },
            { id: "note", header: d.versionsColumns.note, locked: true },
            { id: "saved", header: d.versionsColumns.saved, locked: true },
            { id: "calls", header: d.versionsColumns.calls, align: "end", locked: true },
            { id: "errors", header: d.versionsColumns.errorRate, align: "end", locked: true },
            { id: "latency", header: d.versionsColumns.latency, align: "end", locked: true },
          ]}
          rows={detail.versions.map((v) => ({
            id: String(v.version),
            label: v.tag,
            cells: {
              version: (
                <span className="font-medium whitespace-nowrap">
                  <code className="font-mono text-xs">{v.tag}</code>
                  {v.parentVersion != null ? (
                    <span className="text-muted-foreground block text-xs font-normal">
                      {d.derivedFrom(v.parentVersion)}
                    </span>
                  ) : null}
                </span>
              ),
              state: (
                <Badge
                  variant={v.state === "stable" ? "success" : v.state === "canary" ? "warning" : "outline"}
                >
                  {d.state[v.state]}
                  {v.state === "canary" ? ` ${d.canaryShare(Math.round(v.canaryShare * 100))}` : ""}
                </Badge>
              ),
              note: <span className="block max-w-xs text-xs">{v.note ?? t.admin.common.dash}</span>,
              saved: (
                <span className="text-muted-foreground text-xs whitespace-nowrap">
                  {formatDate(v.createdAt)}
                  <span className="block">{actorLabel(v.createdBy, t.admin.common.dash)}</span>
                </span>
              ),
              calls: <span className="tabular-nums">{v.stats.calls}</span>,
              errors: (
                <span className="tabular-nums">
                  {v.stats.calls > 0 ? formatPercent(v.stats.errorRate) : t.admin.common.dash}
                </span>
              ),
              latency: (
                <span className="tabular-nums">
                  {v.stats.calls > 0 ? formatDuration(v.stats.meanLatencyMs) : t.admin.common.dash}
                </span>
              ),
            },
            actions: (
              <RowActions>
                <IconButton
                  label={d.compareNamed(v.version)}
                  icon={<GitCompareIcon />}
                  onClick={() => {
                    setLeft("shipped");
                    setRight(v.version);
                    diffHeadingRef.current?.focus();
                  }}
                />
                <IconButton
                  label={d.editCopyNamed(v.version)}
                  icon={<PencilIcon />}
                  onClick={() => {
                    startFrom(v.version);
                    textareaRef.current?.focus();
                  }}
                />
                {v.state !== "stable" ? (
                  <IconButton
                    label={d.useNamed(v.version)}
                    icon={<PlayIcon />}
                    disabled={action.busy}
                    onClick={() => {
                      setUsing(v);
                    }}
                  />
                ) : null}
              </RowActions>
            ),
          }))}
          page={{
            page: 1,
            limit: Math.max(detail.versions.length, 1),
            count: detail.versions.length,
            total: detail.versions.length,
          }}
          empty={{ title: d.versionsEmpty }}
        />
      </section>

      <UseDialog
        version={using}
        busy={action.busy}
        onClose={() => {
          setUsing(null);
        }}
        onConfirm={(version, percent) => {
          setUsing(null);
          void action.run(async () => {
            await staffClient.prompts.activate(key, version, percent / 100);
            router.refresh();
            action.setFlash({ kind: "success", text: d.activated(version, percent) });
          });
        }}
      />

      <ConfirmDialog
        open={confirm === "stop"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={d.stopCanaryTitle}
        description={<p>{d.stopCanaryBody(canary?.version ?? 0)}</p>}
        confirmLabel={d.stopCanaryConfirm}
        tone="default"
        onConfirm={() => {
          void action.run(async () => {
            await staffClient.prompts.stopCanary(key);
            router.refresh();
            action.setFlash({ kind: "success", text: d.canaryStopped });
          });
        }}
      />
      <ConfirmDialog
        open={confirm === "rollback"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={d.rollBackTitle}
        description={<p>{d.rollBackBody}</p>}
        confirmLabel={d.rollBackConfirm}
        tone="default"
        onConfirm={() => {
          void action.run(async () => {
            await staffClient.prompts.rollback(key);
            router.refresh();
            action.setFlash({ kind: "success", text: d.rolledBack });
          });
        }}
      />
      <ConfirmDialog
        open={confirm === "reset"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={d.resetTitle}
        description={<p>{d.resetBody}</p>}
        confirmLabel={d.resetConfirm}
        onConfirm={() => {
          void action.run(async () => {
            await staffClient.prompts.reset(key);
            router.refresh();
            action.setFlash({ kind: "success", text: d.resetDone });
          });
        }}
      />
    </div>
  );
}

/**
 * Choosing the share of new interviews a version gets. The slider and the number are one value:
 * the slider is quick, the number is exact and reachable without a pointer. 100 makes the version
 * the one in use; anything lower starts a canary.
 */
function UseDialog({
  version,
  busy,
  onClose,
  onConfirm,
}: {
  version: PromptVersion | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (version: number, percent: number) => void;
}): React.JSX.Element {
  const d = t.admin.prompts.detail;
  const [percent, setPercent] = React.useState(10);
  // What is typed in the number field, which may be half-way to a number (empty, or 2 on the way to 25).
  const [text, setText] = React.useState("10");
  React.useEffect(() => {
    if (!version) return;
    const start = version.state === "canary" ? Math.round(version.canaryShare * 100) : 10;
    setPercent(start);
    setText(String(start));
  }, [version]);
  const clamp = (n: number): number => Math.min(100, Math.max(1, Math.round(n)));
  const typed = Number(text);
  const typedValid = text.trim() !== "" && Number.isInteger(typed) && typed >= 1 && typed <= 100;
  const setBoth = (n: number): void => {
    const next = clamp(n);
    setPercent(next);
    setText(String(next));
  };
  const n = version?.version ?? 0;
  return (
    <Dialog
      open={version !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent closeLabel={t.app.close}>
        <DialogHeader>
          <DialogTitle>{d.useTitle(n)}</DialogTitle>
          <DialogDescription>{d.useDescription}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <label htmlFor="use-share" className="text-sm font-medium">
              {d.shareLabel}
            </label>
            <input
              id="use-share"
              type="range"
              min={1}
              max={100}
              step={1}
              value={percent}
              aria-valuetext={`${String(percent)} %`}
              className="accent-primary w-full"
              onChange={(e) => {
                setBoth(Number(e.target.value));
              }}
            />
          </div>
          <div className="grid max-w-32 gap-1.5">
            <label htmlFor="use-share-number" className="text-sm font-medium">
              {d.shareNumberLabel}
            </label>
            <Input
              id="use-share-number"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              value={text}
              aria-invalid={typedValid ? undefined : true}
              onChange={(e) => {
                setText(e.target.value);
                const n = Number(e.target.value);
                if (e.target.value.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= 100) setPercent(n);
              }}
              onBlur={() => {
                if (text.trim() !== "" && Number.isFinite(typed)) setBoth(typed);
                else setText(String(percent));
              }}
            />
          </div>
          <p className="text-sm" role="status">
            {d.shareHelp(percent, n)}
          </p>
          {percent >= 20 ? <p className="text-muted-foreground text-sm">{d.shareSmall}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t.app.cancel}
          </Button>
          <Button
            type="button"
            disabled={busy || !typedValid}
            onClick={() => {
              onConfirm(n, percent);
            }}
          >
            {d.useConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
