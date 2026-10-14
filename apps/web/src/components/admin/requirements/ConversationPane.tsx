"use client";

import type { Path } from "@aidp/shared";
import { AlertTriangleIcon, CheckIcon, RotateCcwIcon } from "lucide-react";
import * as React from "react";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { Composer } from "@/components/participant/Composer";
import { MessageList } from "@/components/participant/MessageList";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { WidgetRenderer } from "@/components/widgets";
import { useInterview } from "@/hooks/useInterview";
import { t } from "@/i18n";
import { errorMessage } from "@/lib/api/errors";
import type { ParticipantApi } from "@/lib/api/participant";
import type { LiveSpec, ParticipantSession } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

const PATHS = ["technical", "nontechnical"] as const;

function PathSwitch({
  value,
  disabled,
  onChange,
}: {
  value: Path | null;
  disabled: boolean;
  onChange: (path: Path) => void;
}): React.JSX.Element {
  const s = t.admin.requirements;
  return (
    <div role="group" aria-label={s.workspace.pathLabel} className="bg-muted inline-flex rounded-lg p-0.5">
      {PATHS.map((p) => (
        <button
          key={p}
          type="button"
          disabled={disabled}
          aria-pressed={value === p}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
            value === p ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
          )}
          onClick={() => {
            onChange(p);
          }}
        >
          {s.paths[p]}
        </button>
      ))}
    </div>
  );
}

/**
 * The owner's side of a requirements session: the interview hook over the staff routes,
 * the message list with widgets, the composer, and the path / done / reopen controls.
 */
export function ConversationPane({
  api,
  initial,
  title,
  onSpec,
  onSetPath,
  onReopen,
}: {
  api: ParticipantApi;
  initial: ParticipantSession;
  title: string;
  onSpec: (spec: LiveSpec) => void;
  onSetPath: (path: Path) => Promise<void>;
  onReopen: () => Promise<void>;
}): React.JSX.Element {
  const s = t.admin.requirements.workspace;
  const p = t.participant.session;
  const { state, activeWidget, sendText, sendWidget, sendControl, retry, clearError } = useInterview(
    api,
    initial,
    { onSpec },
  );
  const [path, setPath] = React.useState<Path | null>(initial.path ?? null);
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(errorMessage(e, t.app.unknownError));
    } finally {
      setBusy(false);
    }
  };

  const changePath = (next: Path): void => {
    if (next === path) return;
    const previous = path;
    setPath(next);
    void run(async () => {
      try {
        await onSetPath(next);
      } catch (e) {
        setPath(previous);
        throw e;
      }
    });
  };
  const done = (): void => {
    // A control on the turn request, not a message the owner "said" (D-170): the closing question
    // streams straight away and the transcript stays what was actually said.
    void run(async () => {
      await sendControl({ type: "finish" });
    });
  };

  const inputDisabled = state.pending || busy || state.ended;
  const showWidget = activeWidget !== undefined && !state.ended;
  const isBudget = state.error?.code === "budget_exceeded";
  const isProvider = state.error?.code === "provider_error";
  const lastId = state.messages[state.messages.length - 1]?.id;

  return (
    <section
      aria-label={s.conversation}
      className="bg-card shadow-card flex min-h-[60dvh] flex-col rounded-lg lg:sticky lg:top-20 lg:h-[calc(100dvh-6.5rem)] lg:min-h-0"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-base font-semibold" title={title}>
            {s.conversation}
          </h2>
          <StatusBadge status={state.ended ? "completed" : initial.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PathSwitch value={path} disabled={busy || state.ended} onChange={changePath} />
          {state.ended ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                void run(onReopen);
              }}
            >
              <RotateCcwIcon /> {s.reopen}
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={inputDisabled} onClick={done}>
              <CheckIcon /> {s.done}
            </Button>
          )}
        </div>
      </header>

      <div className="max-h-[70dvh] min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:max-h-none">
        <MessageList messages={state.messages} streaming={state.streaming} pending={state.pending}>
          {showWidget ? (
            <div aria-label={p.widgetAnswer} className="bg-card shadow-card mt-1 rounded-2xl p-4">
              <WidgetRenderer
                key={lastId}
                widget={activeWidget}
                disabled={inputDisabled}
                onSubmit={(r) => {
                  void sendWidget(activeWidget, r);
                }}
              />
            </div>
          ) : null}
          {state.error ? (
            <Alert variant={isBudget ? "warning" : "destructive"} className="mt-2">
              <AlertTriangleIcon />
              <AlertTitle>
                {isBudget ? p.errorBudgetTitle : isProvider ? p.errorProviderTitle : p.errorGenericTitle}
              </AlertTitle>
              <AlertDescription>
                <p>
                  {isBudget
                    ? p.errorBudgetBody
                    : isProvider
                      ? p.errorProviderBody
                      : state.error.message || t.app.unknownError}
                </p>
                {!isBudget ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void retry();
                      }}
                    >
                      {t.app.retry}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={clearError}>
                      {t.app.close}
                    </Button>
                  </div>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
          {actionError ? (
            <Alert variant="destructive" className="mt-2">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}
        </MessageList>
      </div>

      {state.ended ? (
        <footer className="text-muted-foreground flex items-center gap-2 border-t px-4 py-3 text-sm">
          <CheckIcon className="size-4 shrink-0" aria-hidden="true" /> {s.completedNote}
        </footer>
      ) : (
        <footer className="border-t px-4 py-3">
          <Composer disabled={inputDisabled} autoFocus={false} onSend={(text) => sendText(text)} />
        </footer>
      )}
    </section>
  );
}
