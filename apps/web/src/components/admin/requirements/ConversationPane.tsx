"use client";

import type { Path } from "@aidp/shared";
import { AlertTriangleIcon, CheckIcon, FastForwardIcon, RotateCcwIcon } from "lucide-react";
import * as React from "react";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ChatViewport } from "@/components/participant/ChatViewport";
import { Composer } from "@/components/participant/Composer";
import { MessageList } from "@/components/participant/MessageList";
import { TurnStatus, turnPhase, useFocusOnTurn } from "@/components/participant/TurnStatus";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { choiceTileClass } from "@/components/ui/choice-tile";
import { WidgetRenderer } from "@/components/widgets";
import { useInterview } from "@/hooks/useInterview";
import { useCoarsePointer } from "@/hooks/useMediaQuery";
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

interface PaneProps {
  api: ParticipantApi;
  initial: ParticipantSession;
  title: string;
  onSpec: (spec: LiveSpec) => void;
  onSetPath: (path: Path) => Promise<void>;
  onReopen: () => Promise<void>;
}

/**
 * A requirements interview with no path yet (one started from a discovery opportunity) asks for
 * one before the interviewer's first turn. It used to start anyway, and the owner met "Something
 * went wrong: Choose a path before the first turn" (simulation 2026-10-15).
 */
export function ConversationPane(props: PaneProps): React.JSX.Element {
  const { initial, onSetPath } = props;
  const [path, setPath] = React.useState<Path | null>(initial.path ?? null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  if (path !== null || initial.messages.length > 0) {
    return <ConversationBody {...props} initial={path ? { ...initial, path } : initial} />;
  }
  const w = t.admin.requirements.workspace;
  const c = t.participant.path;
  const choose = (next: Path): void => {
    setBusy(true);
    setError(null);
    onSetPath(next)
      .then(() => {
        setPath(next);
      })
      .catch((e: unknown) => {
        setError(errorMessage(e, t.app.unknownError));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <section
      aria-label={w.conversation}
      className="bg-card shadow-card grid content-start gap-4 rounded-lg p-4"
    >
      <div className="grid gap-1">
        <h2 className="text-base font-semibold">{c.title}</h2>
        <p className="text-muted-foreground text-sm">{w.choosePathFirst}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {PATHS.map((p) => (
          <button
            key={p}
            type="button"
            disabled={busy}
            className={cn(choiceTileClass({ disabled: busy }), "grid content-start gap-1 text-left")}
            onClick={() => {
              choose(p);
            }}
          >
            <span className="font-medium">{p === "technical" ? c.technical : c.nontechnical}</span>
            <span className="text-muted-foreground text-sm">
              {p === "technical" ? c.technicalHint : c.nontechnicalHint}
            </span>
          </button>
        ))}
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

/**
 * The owner's side of a requirements session: the interview hook over the staff routes,
 * the message list with widgets, the composer, and the path / done / reopen controls.
 */
function ConversationBody({
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
  // "Wrap up sooner" (D-484): essential topics only, no follow-ups, then the closing question.
  const [wrappedUp, setWrappedUp] = React.useState(false);
  const wrapUp = (): void => {
    setWrappedUp(true);
    void sendControl({ type: "wrap_up" }).then((delivered) => {
      if (!delivered) setWrappedUp(false);
    });
  };

  // The box stays editable while the interviewer replies, so the next answer can be drafted;
  // only sending waits (the composer's `sending`).
  const inputDisabled = busy || state.ended;
  const showWidget = activeWidget !== undefined && !state.ended;
  const isBudget = state.error?.code === "budget_exceeded";
  const isProvider = state.error?.code === "provider_error";
  const lastId = state.messages[state.messages.length - 1]?.id;
  const phase = turnPhase(state);
  const coarse = useCoarsePointer();
  const [focusToken, setFocusToken] = React.useState(0);
  const focusComposer = React.useCallback(() => {
    setFocusToken((n) => n + 1);
  }, []);
  useFocusOnTurn(phase, showWidget, coarse, focusComposer);

  return (
    <section
      aria-label={s.conversation}
      className="bg-card shadow-card flex min-h-0 flex-1 flex-col rounded-lg"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
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
            <>
              {!wrappedUp ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={inputDisabled || state.pending}
                  title={p.wrapUpHint}
                  onClick={wrapUp}
                >
                  <FastForwardIcon />
                  <span className="max-sm:sr-only">{p.wrapUp}</span>
                </Button>
              ) : null}
              <Button size="sm" variant="outline" disabled={inputDisabled || state.pending} onClick={done}>
                <CheckIcon /> {s.done}
              </Button>
            </>
          )}
        </div>
      </header>

      <ChatViewport
        count={state.messages.length}
        contentKey={`${String(state.streaming?.length ?? -1)}|${String(state.pending)}|${state.error?.code ?? ""}|${String(state.ended)}`}
        innerClassName="max-w-none px-4 py-4 sm:px-4"
      >
        <MessageList
          messages={state.messages}
          streaming={state.streaming}
          pending={state.pending}
          announcement={state.lastAnnouncement}
        >
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
      </ChatViewport>

      {state.ended ? (
        <footer className="text-muted-foreground flex shrink-0 items-center gap-2 border-t px-4 py-3 text-sm">
          <CheckIcon className="size-4 shrink-0" aria-hidden="true" /> {s.completedNote}
        </footer>
      ) : (
        <footer className="flex max-h-[60%] shrink-0 flex-col gap-1.5 border-t px-3 pt-2 pb-3">
          {showWidget ? (
            // Quick replies sit right above the box, as on the participant screen; the box stays
            // usable, so the options can always be ignored in favour of a written answer.
            <section
              aria-label={p.widgetAnswer}
              className="bg-muted/50 min-h-0 overflow-y-auto rounded-2xl p-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-300"
            >
              <WidgetRenderer
                key={lastId}
                widget={activeWidget}
                disabled={inputDisabled}
                other={false}
                onSubmit={(r) => {
                  void sendWidget(activeWidget, r);
                }}
              />
            </section>
          ) : null}
          <TurnStatus phase={phase} widget={showWidget} canDictate />
          <div className="bg-muted/60 has-[textarea:focus]:bg-card has-[textarea:focus]:shadow-focus shrink-0 rounded-2xl p-1.5 transition-shadow">
            <Composer
              disabled={inputDisabled}
              sending={state.pending}
              autoFocus={false}
              focusToken={focusToken}
              placeholder={showWidget ? p.composerPlaceholderOther : undefined}
              onSend={(text, modality) => sendText(text, modality)}
              onDictate={(audio, durationMs) => api.transcribe(audio, durationMs)}
            />
          </div>
        </footer>
      )}
    </section>
  );
}
