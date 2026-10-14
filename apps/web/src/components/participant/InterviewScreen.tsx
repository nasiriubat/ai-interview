"use client";

import { AlertTriangleIcon, CheckIcon, PauseIcon, Trash2Icon } from "lucide-react";
import * as React from "react";
import { AttachmentList } from "./AttachmentList";
import { Composer } from "./Composer";
import { LiveVoiceCall } from "./LiveVoiceCall";
import { MessageList } from "./MessageList";
import { ModeSwitch } from "./ModeSwitch";
import { ProgressAreas } from "./ProgressAreas";
import { RecapBanner } from "./RecapBanner";
import { SessionMenu } from "./SessionMenu";
import { StatusScreen } from "./StatusScreen";
import { SummaryView } from "./SummaryView";
import { LanguageSwitch } from "@/components/common/LanguageSwitch";
import { undoToast } from "@/components/common/undoToast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { WidgetRenderer } from "@/components/widgets";
import { useAttachments } from "@/hooks/useAttachments";
import { useInterview } from "@/hooks/useInterview";
import { useLiveVoice } from "@/hooks/useLiveVoice";
import { useOnline } from "@/hooks/useOnline";
import { useSpeech } from "@/hooks/useSpeech";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import { participantClient } from "@/lib/api/browser";
import { participantErrorFor, participantErrorText } from "@/lib/api/errors";
import type { ParticipantApi } from "@/lib/api/participant";
import type { ModePreference, ParticipantSession, ProgressArea } from "@/lib/api/schemas";

type Screen = "interview" | "paused" | "deleted";

/** The confirmation line is shown only when the API says a notice was queued (D-175). */
interface Deleted {
  emailSent: boolean;
}

export function InterviewScreen({
  initial,
  api = participantClient,
  title,
}: {
  initial: ParticipantSession;
  api?: ParticipantApi;
  title?: string;
}): React.JSX.Element {
  const {
    state,
    live: sink,
    activeWidget,
    sendText,
    sendVoice,
    sendWidget,
    sendControl,
    retry,
    clearError,
  } = useInterview(api, initial);
  // Reading a question aloud needs no server and no key (D-76); the voice follows the page's
  // language, which the interview's template sets.
  const speech = useSpeech(useLocale());
  const can = initial.capabilities;
  /** Whether this tenant does spoken answers at all, either way round. */
  const voiceConfigured = can.recordedVoice || can.liveVoice;
  // A stored `voice` preference outlives the setting that allowed it, so it is coerced back.
  const optionsEnabled = can.optionsView !== false;
  const [mode, setMode] = React.useState<ModePreference>(
    (initial.modePreference === "voice" && !voiceConfigured) ||
      (initial.modePreference === "options" && !optionsEnabled)
      ? "chat"
      : (initial.modePreference ?? "chat"),
  );
  const [screen, setScreen] = React.useState<Screen>(initial.status === "paused" ? "paused" : "interview");
  const [deleted, setDeleted] = React.useState<Deleted>({ emailSent: false });
  /** The recap is shown once per visit: dismissed, or answered past, it does not come back. */
  const [recapDismissed, setRecapDismissed] = React.useState(false);
  const [composerFocus, setComposerFocus] = React.useState(0);
  const recapText = initial.recap?.text;
  const messagesAtOpen = React.useRef(initial.messages.length);
  const attachments = useAttachments(api, {
    initial: initial.attachments,
    capabilities: can,
    enabled: screen === "interview" && !state.ended,
  });
  const [typeInstead, setTypeInstead] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  /**
   * A failed request is the authority on being offline; `navigator.onLine` only decides whether the
   * Retry button is worth pressing and when to retry once on its own. The automatic retry happens
   * only on a real offline-to-online transition after the failure, so a server that is down cannot
   * make this loop.
   */
  const online = useOnline();
  const networkFailure = state.error?.code === "network_error";
  const wentOffline = React.useRef(false);
  const [resending, setResending] = React.useState(false);
  React.useEffect(() => {
    if (!networkFailure) {
      wentOffline.current = false;
      return;
    }
    if (!online) {
      wentOffline.current = true;
      return;
    }
    if (wentOffline.current) {
      wentOffline.current = false;
      setResending(true);
      void retry().finally(() => {
        setResending(false);
      });
    }
  }, [networkFailure, online, retry]);
  const [busy, setBusy] = React.useState(false);

  /**
   * The real-time cascade (FR-30a). Its turns land in the same conversation as the typed ones, so
   * the interview reads as one thread whichever way each answer was given.
   *
   * When the call gives up, `gaveUp` holds the rung of spec 09's chain that is still standing, and
   * the screen offers exactly that. `recorded` brings the microphone back; `text` means there is no
   * transcription route at all, so the microphone would fail the same way and pointing at it would
   * be the one suggestion guaranteed not to work. Either way the session is untouched, which is
   * what "without losing the session" asks for.
   */
  const [gaveUp, setGaveUp] = React.useState<"recorded" | "text" | null>(null);
  const live = useLiveVoice({
    onTurn: sink.turn,
    onHeard: sink.heard,
    onEnded: sink.ended,
    onError: sink.failed,
    onUnavailable: setGaveUp,
  });
  const spokenAnswers = gaveUp !== "text";
  const liveOffered = can.liveVoice && gaveUp === null;
  const inCall = live.status !== "idle" && live.status !== "unavailable";

  // Nothing under the voice mode can work without a route that listens, so the interview moves to
  // typing rather than leaving a mode selected whose every control is broken.
  React.useEffect(() => {
    if (spokenAnswers) return;
    setMode("chat");
    api.setMode("chat", "fallback_typing").catch(() => undefined);
  }, [spokenAnswers, api]);

  const changeMode = (m: ModePreference): void => {
    setMode(m);
    setTypeInstead(false);
    // The call reads the question already on screen as soon as it is up, so entering voice
    // halfway through an interview sounds like picking up a phone rather than like silence.
    if (m === "voice" && liveOffered) live.start();
    else live.end();
    api.setMode(m).catch(() => undefined);
  };

  /**
   * Every turn taken over HTTP needs the call out of the way first: the server refuses two turns
   * on one session, and a participant who just typed has chosen to stop talking anyway.
   */
  const typedTurn = (fn: () => void): void => {
    live.end();
    fn();
  };

  const run = async (fn: () => Promise<void>): Promise<void> => {
    live.end();
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(participantErrorText(e, "interview"));
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
  // "I'm done", skipping and coming back are operations on the interview, not things the
  // participant said: they go as controls and never reach the transcript (D-170).
  const done = (): void => {
    void run(async () => {
      await sendControl({ type: "finish" });
    });
  };
  const remove = (): void => {
    void run(async () => {
      const result = await api.deleteData();
      setDeleted({ emailSent: result.emailSent });
      setScreen("deleted");
    });
  };
  const back = (area: ProgressArea): void => {
    typedTurn(() => {
      void sendControl({ type: "return_area", areaKey: area.key });
    });
  };
  const skip = (area: ProgressArea): void => {
    typedTurn(() => {
      void sendControl({ type: "skip_area", areaKey: area.key }).then((delivered) => {
        // Reversible with one click, so it is not asked about but can be undone for six seconds
        // (D-111). Undo is the inverse operation, sent like any other control.
        if (delivered)
          undoToast(t.participant.session.skippedToast(area.name), () => {
            back(area);
          });
      });
    });
  };

  if (screen === "deleted") {
    return (
      <StatusScreen
        icon={<Trash2Icon />}
        tone="success"
        title={t.participant.session.deletedTitle}
        body={t.participant.session.deletedBody}
        {...(deleted.emailSent ? { note: <p>{t.participant.session.deletedEmailNote}</p> } : {})}
      />
    );
  }
  if (screen === "paused") {
    return (
      <StatusScreen
        icon={<PauseIcon />}
        title={t.participant.session.pausedTitle}
        body={t.participant.session.pausedBody}
        {...(recapText
          ? {
              note: (
                <>
                  <p className="text-foreground font-semibold">{t.participant.session.recapLabel}</p>
                  <p className="mt-1">{recapText}</p>
                </>
              ),
            }
          : {})}
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
  // Only the options mode hides the composer behind a widget; chat and voice always keep it.
  const showComposer = !state.ended && (mode !== "options" || !showWidget || typeInstead);
  const isBudget = state.error?.code === "budget_exceeded";
  const isOffline = networkFailure;
  const isProvider = state.error?.code === "provider_error";
  const isExpired = state.error?.code === "unauthenticated" || state.error?.code === "not_found";

  return (
    <div className="flex min-h-dvh w-full flex-col">
      <header className="bg-card/90 supports-[backdrop-filter]:bg-card/75 sticky top-0 z-10 border-b backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-2 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden="true"
              className="hidden size-7 shrink-0 place-items-center rounded-md bg-brand-gradient text-xs font-bold text-white sm:grid"
            >
              D
            </span>
            <h1 className="text-foreground truncate text-[15px] font-semibold tracking-tight">
              {title ?? t.participant.session.title}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {!state.ended ? (
              <ModeSwitch
                mode={mode}
                onChange={changeMode}
                voiceEnabled={voiceConfigured && spokenAnswers}
                optionsEnabled={optionsEnabled}
              />
            ) : null}
            <LanguageSwitch />
            <SessionMenu onPause={pause} onDone={done} onDelete={remove} disabled={busy || state.ended} />
          </div>
        </div>
        <div className="mx-auto max-w-2xl px-4 pb-2">
          <ProgressAreas
            areas={state.progress.areas}
            disabled={inputDisabled}
            onSkip={skip}
            onReturn={back}
          />
        </div>
        {!online ? (
          // The failure itself is an alert; this only keeps the state visible while it lasts.
          <p
            role="status"
            className="bg-warning-soft text-warning-soft-foreground px-4 py-1.5 text-center text-xs font-medium"
          >
            {t.participant.session.offlineBar}
          </p>
        ) : null}
      </header>

      <main id="main" className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
        {recapText && !recapDismissed && !state.ended && state.messages.length <= messagesAtOpen.current ? (
          <RecapBanner
            text={recapText}
            onDismiss={() => {
              setRecapDismissed(true);
            }}
            onContinue={() => {
              setRecapDismissed(true);
              setComposerFocus((n) => n + 1);
            }}
          />
        ) : null}
        <MessageList
          messages={state.messages}
          streaming={state.streaming}
          pending={state.pending}
          announcement={state.lastAnnouncement}
          speech={speech}
        >
          {showWidget ? (
            <section
              aria-label={t.participant.session.widgetAnswer}
              className="bg-card shadow-card mt-1 rounded-2xl p-4"
            >
              <WidgetRenderer
                key={state.messages[state.messages.length - 1]?.id}
                widget={activeWidget}
                disabled={inputDisabled}
                onSubmit={(r) => {
                  typedTurn(() => {
                    void sendWidget(activeWidget, r);
                  });
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
                {isOffline
                  ? t.participant.session.offlineTitle
                  : isBudget
                    ? t.participant.session.errorBudgetTitle
                    : isProvider
                      ? t.participant.session.errorProviderTitle
                      : isExpired
                        ? t.participant.session.errorExpiredTitle
                        : t.participant.session.errorGenericTitle}
              </AlertTitle>
              <AlertDescription>
                <p>
                  {isOffline
                    ? t.participant.session.offlineBody
                    : isBudget
                      ? t.participant.session.errorBudgetBody
                      : isProvider
                        ? t.participant.session.errorProviderBody
                        : isExpired
                          ? t.participant.session.errorExpiredBody
                          : participantErrorFor(state.error.code, "interview")}
                </p>
                {!isBudget && !isExpired ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isOffline && !online}
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
          {resending ? (
            <p role="status" className="text-muted-foreground mt-2 text-sm">
              {t.participant.session.backOnline}
            </p>
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
        <footer className="from-background via-background sticky bottom-0 bg-gradient-to-t from-60% to-transparent px-4 pt-6 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="bg-card shadow-raised mx-auto grid max-w-2xl gap-2 rounded-2xl p-2">
            {mode === "voice" && liveOffered ? (
              <LiveVoiceCall live={live} disabled={inputDisabled} onStart={live.start} />
            ) : null}
            {gaveUp !== null ? (
              <p className="text-muted-foreground mb-2 text-sm" role="status">
                {gaveUp === "text"
                  ? t.participant.session.liveTypeOnly
                  : t.participant.session.liveUnavailable}
              </p>
            ) : null}
            <AttachmentList
              items={attachments.items}
              uploading={attachments.uploading}
              error={attachments.error}
              onRemove={attachments.remove}
              fetchBytes={attachments.bytes}
            />
            <Composer
              disabled={inputDisabled}
              autoFocus={!showWidget}
              voiceFirst={mode === "voice" && !inCall}
              focusToken={composerFocus}
              onSend={(text) => {
                setTypeInstead(false);
                live.end();
                // Resolves false when the turn failed, so the composer can give the text back.
                return sendText(text);
              }}
              onVoice={
                // One microphone at a time: while a live call is up, recording an answer as well
                // would take a second turn on a session that only allows one. And with no route
                // that listens, recorded voice transcribes through the same missing thing the call
                // just failed on, so the button is withdrawn rather than left as a dead end.
                can.recordedVoice && !inCall && spokenAnswers
                  ? (audio, durationMs) => {
                      setTypeInstead(false);
                      // The turn stores the audio server-side, so the list is re-read afterwards
                      // and the participant can play back what they said.
                      void sendVoice(audio, durationMs).then(attachments.refresh);
                    }
                  : undefined
              }
              onFile={
                can.fileUpload
                  ? (file) => {
                      attachments.upload(file);
                    }
                  : undefined
              }
              accept={attachments.accept}
            />
          </div>
        </footer>
      ) : state.ended ? (
        <footer className="text-muted-foreground flex items-center justify-center gap-2 px-4 py-3 text-sm">
          <CheckIcon className="size-4" aria-hidden="true" /> {t.participant.session.completedTitle}
        </footer>
      ) : null}
    </div>
  );
}
