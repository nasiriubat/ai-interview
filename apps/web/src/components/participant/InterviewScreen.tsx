"use client";

import { AlertTriangleIcon, CheckIcon, PauseIcon, Trash2Icon } from "lucide-react";
import * as React from "react";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { ModeSwitch } from "./ModeSwitch";
import { ProgressAreas } from "./ProgressAreas";
import { SessionMenu } from "./SessionMenu";
import { StatusScreen } from "./StatusScreen";
import { SummaryView } from "./SummaryView";
import { LanguageSwitch } from "@/components/common/LanguageSwitch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { WidgetRenderer } from "@/components/widgets";
import { useInterview } from "@/hooks/useInterview";
import { t } from "@/i18n";
import { participantClient } from "@/lib/api/browser";
import { errorMessage } from "@/lib/api/errors";
import type { ParticipantApi } from "@/lib/api/participant";
import type { ModePreference, ParticipantSession, ProgressArea } from "@/lib/api/schemas";

type Screen = "interview" | "paused" | "deleted";

export function InterviewScreen({
  initial,
  api = participantClient,
  title,
}: {
  initial: ParticipantSession;
  api?: ParticipantApi;
  title?: string;
}): React.JSX.Element {
  const { state, activeWidget, sendText, sendWidget, retry, clearError } = useInterview(api, initial);
  const [mode, setMode] = React.useState<ModePreference>(
    initial.modePreference && initial.modePreference !== "voice" ? initial.modePreference : "chat",
  );
  const [screen, setScreen] = React.useState<Screen>(initial.status === "paused" ? "paused" : "interview");
  const [typeInstead, setTypeInstead] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const changeMode = (m: ModePreference): void => {
    setMode(m);
    setTypeInstead(false);
    api.setMode(m).catch(() => undefined);
  };

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

  const pause = (): void => {
    void run(async () => {
      await api.pause();
      setScreen("paused");
    });
  };
  const done = (): void => {
    void run(async () => {
      await api.complete();
      await sendText(t.participant.session.doneMessage);
    });
  };
  const remove = (): void => {
    void run(async () => {
      await api.deleteData();
      setScreen("deleted");
    });
  };
  const skip = (area: ProgressArea): void => {
    void sendText(`${t.participant.session.skipMessage} (${area.name})`);
  };
  const back = (area: ProgressArea): void => {
    void sendText(t.participant.session.returnMessage(area.name));
  };

  if (screen === "deleted") {
    return (
      <StatusScreen
        icon={<Trash2Icon />}
        tone="success"
        title={t.participant.session.deletedTitle}
        body={t.participant.session.deletedBody}
      />
    );
  }
  if (screen === "paused") {
    return (
      <StatusScreen
        icon={<PauseIcon />}
        title={t.participant.session.pausedTitle}
        body={t.participant.session.pausedBody}
      >
        <Button
          onClick={() => {
            setScreen("interview");
          }}
        >
          {t.participant.session.resumeNow}
        </Button>
      </StatusScreen>
    );
  }

  const inputDisabled = state.pending || busy || state.ended;
  const showWidget = activeWidget !== undefined && !state.ended;
  const showComposer = !state.ended && (mode === "chat" || !showWidget || typeInstead);
  const isBudget = state.error?.code === "budget_exceeded";
  const isProvider = state.error?.code === "provider_error";
  const isExpired = state.error?.code === "unauthenticated" || state.error?.code === "not_found";

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col">
      <header className="bg-background/95 sticky top-0 z-10 border-b backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex items-center justify-between gap-2 px-4 py-2">
          <h1 className="truncate text-base font-semibold">{title ?? t.participant.session.title}</h1>
          <div className="flex items-center gap-2">
            {!state.ended ? <ModeSwitch mode={mode} onChange={changeMode} /> : null}
            <LanguageSwitch className="hidden sm:flex" />
            <SessionMenu onPause={pause} onDone={done} onDelete={remove} disabled={busy || state.ended} />
          </div>
        </div>
        <div className="px-4 pb-2">
          <ProgressAreas
            areas={state.progress.areas}
            disabled={inputDisabled}
            onSkip={skip}
            onReturn={back}
          />
        </div>
      </header>

      <main id="main" className="flex-1 px-4 py-4">
        <MessageList messages={state.messages} streaming={state.streaming} pending={state.pending}>
          {showWidget ? (
            <section
              aria-label={t.participant.session.widgetAnswer}
              className="bg-card mt-1 rounded-2xl border p-4"
            >
              <WidgetRenderer
                key={state.messages[state.messages.length - 1]?.id}
                widget={activeWidget}
                disabled={inputDisabled}
                onSubmit={(r) => {
                  void sendWidget(activeWidget, r);
                }}
              />
              {mode === "options" && !typeInstead ? (
                <Button
                  variant="link"
                  className="mt-2 h-auto p-0 text-xs"
                  onClick={() => {
                    setTypeInstead(true);
                  }}
                >
                  {t.participant.session.typeInstead}
                </Button>
              ) : null}
            </section>
          ) : null}
          {state.error ? (
            <Alert variant={isBudget ? "warning" : "destructive"} className="mt-2">
              <AlertTriangleIcon />
              <AlertTitle>
                {isBudget
                  ? t.participant.session.errorBudgetTitle
                  : isProvider
                    ? t.participant.session.errorProviderTitle
                    : isExpired
                      ? t.participant.session.errorExpiredTitle
                      : t.participant.session.errorGenericTitle}
              </AlertTitle>
              <AlertDescription>
                <p>
                  {isBudget
                    ? t.participant.session.errorBudgetBody
                    : isProvider
                      ? t.participant.session.errorProviderBody
                      : isExpired
                        ? t.participant.session.errorExpiredBody
                        : state.error.message || t.app.unknownError}
                </p>
                {!isBudget && !isExpired ? (
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
          {state.ended ? (
            <SummaryView
              api={api}
              available={state.summaryAvailable || initial.status === "completed"}
              onDelete={remove}
            />
          ) : null}
        </MessageList>
      </main>

      {showComposer ? (
        <footer className="bg-background sticky bottom-0 border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Composer
            disabled={inputDisabled}
            autoFocus={!showWidget}
            onSend={(text) => {
              setTypeInstead(false);
              void sendText(text);
            }}
          />
        </footer>
      ) : state.ended ? (
        <footer className="text-muted-foreground flex items-center justify-center gap-2 px-4 py-3 text-sm">
          <CheckIcon className="size-4" aria-hidden="true" /> {t.participant.session.completedTitle}
        </footer>
      ) : null}
    </div>
  );
}
