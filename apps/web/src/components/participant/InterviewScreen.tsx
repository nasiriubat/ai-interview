"use client";

import { AlertTriangleIcon, CheckIcon, PauseIcon, Trash2Icon } from "lucide-react";
import * as React from "react";
import { AttachmentList } from "./AttachmentList";
import { ChatViewport } from "./ChatViewport";
import { Composer } from "./Composer";
import { LiveVoiceCall } from "./LiveVoiceCall";
import { LiveVoiceScreen } from "./LiveVoiceScreen";
import { announcementText, MessageList } from "./MessageList";
import { InterviewFrame } from "./ParticipantFrame";
import { RecapBanner } from "./RecapBanner";
import { SessionMenu } from "./SessionMenu";
import { SessionPanel } from "./SessionPanel";
import { StatusScreen } from "./StatusScreen";
import { SummaryView } from "./SummaryView";
import type { ClipSource } from "./VoiceClip";
import { undoToast } from "@/components/common/undoToast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { WidgetRenderer } from "@/components/widgets";
import { WidgetVoiceProvider, type WidgetVoice } from "@/components/widgets/voice-context";
import { useAttachments } from "@/hooks/useAttachments";
import { controlChipOf, useInterview } from "@/hooks/useInterview";
import { useLiveVoice } from "@/hooks/useLiveVoice";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useOnline } from "@/hooks/useOnline";
import { useSpeech } from "@/hooks/useSpeech";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import { participantClient } from "@/lib/api/browser";
import { participantErrorFor, participantErrorText } from "@/lib/api/errors";
import type { ParticipantApi } from "@/lib/api/participant";
import type { Message, ModePreference, ParticipantSession, ProgressArea } from "@/lib/api/schemas";

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
  // What the person used last is kept silently: it only decides whether Talk or the microphone is
  // emphasised the next time. There is no mode to choose (D-421).
  const [preferred, setPreferred] = React.useState<ModePreference>(
    initial.modePreference === "voice" && voiceConfigured ? "voice" : "chat",
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
  const [deleteOpen, setDeleteOpen] = React.useState(false);
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
  // The "Other" field takes speech where recorded voice is on and no call holds the microphone.
  const widgetVoice = React.useMemo<WidgetVoice | null>(
    () =>
      can.recordedVoice && spokenAnswers && live.status === "idle"
        ? { transcribe: (audio, ms) => api.transcribe(audio, ms) }
        : null,
    [can.recordedVoice, spokenAnswers, live.status, api],
  );
  const liveOffered = can.liveVoice && gaveUp === null;
  const inCall = live.status !== "idle" && live.status !== "unavailable";
  // On a phone the call is a screen of its own (D-238); elsewhere it stays the panel above the composer.
  const phone = useMediaQuery("(max-width: 767px)");
  const callScreen = phone && inCall;

  // Nothing under the voice mode can work without a route that listens, so the interview moves to
  // typing rather than leaving a mode selected whose every control is broken.
  React.useEffect(() => {
    if (spokenAnswers) return;
    setPreferred("chat");
    api.setMode("chat", "fallback_typing").catch(() => undefined);
  }, [spokenAnswers, api]);

  /** Remembered silently, so the next visit can lead with the same way of answering. */
  const remember = (m: ModePreference): void => {
    if (m === preferred) return;
    setPreferred(m);
    api.setMode(m).catch(() => undefined);
  };
  // The call reads the question already on screen as soon as it is up, so starting it halfway
  // through an interview sounds like picking up a phone rather than like silence.
  const talk = (): void => {
    remember("voice");
    live.start();
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
  const finish = (): void => {
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

  // A recording belongs to the spoken message nearest it in time (the server stores the audio with
  // the turn and the client has only the two lists). One recording is never shown on two messages.
  const clipFor = React.useMemo(() => {
    const audio = attachments.items.filter((a) => a.kind === "audio" && a.status !== "failed");
    const taken = new Set<string>();
    const out = new Map<string, ClipSource>();
    const spoken = state.messages.filter(
      (m) => m.role === "user" && m.modality === "voice" && !m.id.startsWith("local-"),
    );
    for (const m of spoken) {
      const own = audio.find((a) => a.messageId === m.id || a.id === m.attachmentId);
      if (own) {
        taken.add(own.id);
        out.set(m.id, { attachment: own, fetchBytes: attachments.bytes });
      }
    }
    for (const m of spoken) {
      if (out.has(m.id)) continue;
      const at = Date.parse(m.createdAt);
      let best: (typeof audio)[number] | undefined;
      let bestGap = 90_000;
      for (const a of audio) {
        if (taken.has(a.id)) continue;
        const gap = Math.abs(Date.parse(a.createdAt) - at);
        if (gap <= bestGap) {
          best = a;
          bestGap = gap;
        }
      }
      if (best) {
        taken.add(best.id);
        out.set(m.id, { attachment: best, fetchBytes: attachments.bytes });
      }
    }
    return (m: Message): ClipSource | undefined => out.get(m.id);
  }, [attachments.items, attachments.bytes, state.messages]);

  const identity =
    initial.about?.name === undefined || initial.about.name === "" ? undefined : initial.about.name;
  if (screen === "deleted") {
    return (
      <StatusScreen
        identity={identity}
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
        identity={identity}
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
  const showComposer = !state.ended;
  const isBudget = state.error?.code === "budget_exceeded";
  const isOffline = networkFailure;
  const isProvider = state.error?.code === "provider_error";
  const isExpired = state.error?.code === "unauthenticated" || state.error?.code === "not_found";

  const lastMessage = state.messages[state.messages.length - 1];
  const voiceSendFailed =
    state.error !== null &&
    lastMessage?.role === "user" &&
    lastMessage.modality === "voice" &&
    lastMessage.content === "" &&
    lastMessage.id.startsWith("local-");
  // The retry is in the recording's own bubble, so the banner would only say it twice.
  const showErrorAlert = state.error !== null && (!voiceSendFailed || isBudget || isExpired);
  const visibleCount = state.messages.filter(
    (m) => m.role !== "system" || controlChipOf(m) !== undefined,
  ).length;
  const areas = state.progress.areas;
  const covered = areas.filter((a) => a.status === "covered").length;
  const aboutName = initial.about?.name;
  const name =
    aboutName !== undefined && aboutName !== "" ? aboutName : (title ?? t.participant.session.title);

  const panel = (
    <SessionPanel
      purpose={initial.about?.purpose}
      areas={areas}
      disabled={inputDisabled}
      onSkip={skip}
      onReturn={back}
      onRequestDelete={() => {
        setDeleteOpen(true);
      }}
    />
  );

  return (
    <>
      <InterviewFrame
        title={name}
        subtitle={initial.about?.productName}
        progress={{ done: covered, total: areas.length }}
        onPause={pause}
        pauseDisabled={busy || state.ended}
        menu={
          <SessionMenu
            onDone={finish}
            onDelete={remove}
            disabled={busy || state.ended}
            deleteOpen={deleteOpen}
            onDeleteOpenChange={setDeleteOpen}
          />
        }
        panel={panel}
        banner={
          !online ? (
            // The failure itself is an alert; this only keeps the state visible while it lasts.
            <p
              role="status"
              className="bg-warning-soft text-warning-soft-foreground shrink-0 px-4 py-1.5 text-center text-xs font-medium"
            >
              {t.participant.session.offlineBar}
            </p>
          ) : null
        }
      >
        {recapText && !recapDismissed && !state.ended && state.messages.length <= messagesAtOpen.current ? (
          <div className="mx-auto w-full max-w-[780px] shrink-0 px-4 pt-4 sm:px-6">
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
          </div>
        ) : null}
        <ChatViewport
          count={visibleCount}
          contentKey={`${String(state.streaming?.length ?? -1)}|${String(state.pending)}|${String(
            showWidget,
          )}|${state.error?.code ?? ""}|${String(state.ended)}`}
        >
          <MessageList
            messages={state.messages}
            streaming={state.streaming}
            pending={state.pending}
            announcement={state.lastAnnouncement}
            speech={speech}
            followEnd={false}
            clipFor={clipFor}
            failedSend={state.error !== null}
            onRetrySend={() => {
              void retry();
            }}
          >
            {showErrorAlert && state.error ? (
              <Alert
                variant={isBudget || isOffline || isProvider || isExpired ? "warning" : "destructive"}
                className="mt-3"
              >
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
              <Alert variant="destructive" className="mt-3">
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
        </ChatViewport>

        {showComposer ? (
          <footer className="bg-card flex max-h-[55dvh] shrink-0 flex-col border-t px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:rounded-b-2xl sm:px-5">
            <div className="mx-auto flex min-h-0 w-full max-w-[780px] flex-col gap-1.5">
              <div className="grid max-h-[38dvh] min-h-0 gap-1.5 overflow-y-auto empty:hidden">
                {showWidget && !inCall ? (
                  // Quick replies: whatever the interviewer offers sits right above the box, and the
                  // box stays usable, so a person can always ignore the choices and type.
                  <section
                    aria-label={t.participant.session.widgetAnswer}
                    className="bg-muted/50 mb-1 rounded-2xl p-3"
                  >
                    <WidgetVoiceProvider value={widgetVoice}>
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
                    </WidgetVoiceProvider>
                  </section>
                ) : null}
                {liveOffered && inCall ? (
                  <LiveVoiceCall live={live} disabled={inputDisabled} fullScreen={phone} onStart={talk} />
                ) : null}
                {liveOffered && !inCall && live.problem ? (
                  <LiveVoiceCall
                    live={live}
                    disabled={inputDisabled}
                    fullScreen={phone}
                    onStart={talk}
                    hideStart
                  />
                ) : null}
                {gaveUp !== null ? (
                  <p className="text-muted-foreground text-sm" role="status">
                    {gaveUp === "text"
                      ? t.participant.session.liveTypeOnly
                      : t.participant.session.liveUnavailable}
                  </p>
                ) : null}
                <AttachmentList
                  items={attachments.items}
                  uploading={attachments.uploading}
                  progress={attachments.progress}
                  onCancel={attachments.cancelUpload}
                  error={attachments.error}
                  onRemove={attachments.remove}
                  fetchBytes={attachments.bytes}
                />
              </div>
              <div className="bg-muted/60 focus-within:bg-card focus-within:shadow-control shrink-0 rounded-2xl p-1.5 transition-shadow">
                <Composer
                  disabled={state.ended || busy}
                  sending={state.pending}
                  autoFocus={!showWidget}
                  voiceFirst={preferred === "voice" && !inCall}
                  focusToken={composerFocus}
                  onSend={(text) => {
                    remember("chat");
                    live.end();
                    // Resolves false when the turn failed, so the composer can give the text back.
                    return sendText(text);
                  }}
                  onTalk={liveOffered && !inCall ? talk : undefined}
                  onVoice={
                    // One microphone at a time: while a live call is up, recording an answer as
                    // well would take a second turn on a session that only allows one. And with no
                    // route that listens, recorded voice transcribes through the same missing thing
                    // the call just failed on, so the button is withdrawn rather than left as a
                    // dead end.
                    can.recordedVoice && !inCall && spokenAnswers
                      ? (audio, durationMs) => {
                          // The turn stores the audio server-side, so the list is re-read
                          // afterwards and the participant can play back what they said.
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
            </div>
          </footer>
        ) : state.ended ? (
          <footer className="text-muted-foreground flex shrink-0 items-center justify-center gap-2 border-t px-4 py-3 text-sm">
            <CheckIcon className="size-4" aria-hidden="true" /> {t.participant.session.completedTitle}
          </footer>
        ) : null}
      </InterviewFrame>
      <LiveVoiceScreen
        live={live}
        open={callScreen}
        title={name}
        messages={state.messages}
        widget={activeWidget}
        announcement={state.lastAnnouncement ? announcementText(state.lastAnnouncement) : ""}
        onAnswer={(response) => {
          if (!activeWidget) return;
          typedTurn(() => {
            void sendWidget(activeWidget, response);
          });
        }}
        onTypeInstead={() => {
          // Leaving the call for the composer: the call ends and focus goes to the answer box.
          remember("chat");
          live.end();
          setComposerFocus((n) => n + 1);
        }}
        returnFocus={() => {
          document.querySelector<HTMLElement>("[data-talk-button]")?.focus();
        }}
      />
    </>
  );
}
