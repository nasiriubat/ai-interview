"use client";

import type { Widget, WidgetResponse } from "@aidp/shared";
import {
  KeyboardIcon,
  LoaderCircleIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  SquareIcon,
  Volume2Icon,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import * as React from "react";
import { LevelMeter, problemMessage, statusLabel } from "./LiveVoiceCall";
import { Button } from "@/components/ui/button";
import { ChoiceTile } from "@/components/ui/choice-tile";
import type { LiveVoiceController } from "@/hooks/useLiveVoice";
import { t } from "@/i18n";
import type { Message } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

/** `m:ss` for a call, from a start time; a call never shows hours. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m)}:${String(s).padStart(2, "0")}`;
}

/** Counts seconds while `active`; restarts from zero for each call. */
function useElapsed(active: boolean): number {
  const [ms, setMs] = React.useState(0);
  React.useEffect(() => {
    if (!active) {
      setMs(0);
      return;
    }
    const startedAt = Date.now();
    setMs(0);
    const id = window.setInterval(() => {
      setMs(Date.now() - startedAt);
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [active]);
  return ms;
}

/** The options a tap can answer: a single choice or a yes or no. Anything else is read, not tapped. */
function tappable(widget: Widget | undefined): { key: string; label: string; response: WidgetResponse }[] {
  if (!widget) return [];
  if (widget.type === "single_choice")
    return widget.options.map((o) => ({
      key: o.key,
      label: o.label,
      response: { type: "single_choice", key: o.key },
    }));
  if (widget.type === "yes_no")
    return [
      { key: "yes", label: t.app.yes, response: { type: "yes_no", value: true } },
      { key: "no", label: t.app.no, response: { type: "yes_no", value: false } },
    ];
  return [];
}

/**
 * The call as a screen of its own, for phones (D-238). A call is not a form: the participant is
 * looking at the phone only now and then, so the screen shows one thing at large size (what the
 * interviewer is saying), what they themselves are being heard to say, the phase in a word, and
 * three large controls. It reuses the call controller as it is; nothing about the call's state
 * lives here.
 *
 * A modal dialog, so focus is held inside while the call is up and the rest of the page is inert.
 * Focus lands on "End the call" (the one control that is always right), and goes back to the mode
 * switch when the call ends, because the mode switch is what the participant changed. Escape ends
 * the call, which is non-destructive: the interview carries on in text.
 *
 * Captions are never animated word by word: the text appears as it arrives, which is also what
 * reduced motion asks for. The phase word is the screen's one live region; the interviewer's
 * finished sentence is announced once, through a visually hidden status of its own.
 */
export function LiveVoiceScreen({
  live,
  open,
  title,
  messages,
  widget,
  announcement,
  onAnswer,
  onTypeInstead,
  returnFocus,
}: {
  live: LiveVoiceController;
  open: boolean;
  /** The interview's own title, for the header. */
  title: string;
  messages: readonly Message[];
  /** The question's answer options, when it has some. */
  widget: Widget | undefined;
  /** The finished interviewer turn, announced once. */
  announcement: string;
  /** A tapped option: the interview takes it as a typed answer, so the call ends. */
  onAnswer: (response: WidgetResponse) => void;
  onTypeInstead: () => void;
  /** Where focus goes when the call closes. */
  returnFocus: () => void;
}): React.JSX.Element {
  const s = t.participant.session;
  const endRef = React.useRef<HTMLButtonElement>(null);
  const [showAll, setShowAll] = React.useState(false);
  const elapsed = useElapsed(open);

  const spoken = messages.filter((m) => m.role === "assistant" || m.role === "user");
  const lastAssistantIndex = spoken.map((m) => m.role).lastIndexOf("assistant");
  const interviewer = lastAssistantIndex >= 0 ? spoken[lastAssistantIndex] : undefined;
  // What the participant said since the interviewer last spoke, if the server captioned it.
  const reply = spoken.slice(lastAssistantIndex + 1).find((m) => m.role === "user");
  const options = tappable(widget);
  const phase = live.status === "idle" || live.status === "unavailable" ? "listening" : live.status;
  const Icon = live.muted
    ? MicOffIcon
    : phase === "speaking"
      ? Volume2Icon
      : phase === "listening"
        ? MicIcon
        : LoaderCircleIcon;

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) live.end();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="bg-background fixed inset-0 z-50 flex flex-col"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            endRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            returnFocus();
          }}
        >
          <DialogPrimitive.Title className="sr-only">{s.liveScreenTitle}</DialogPrimitive.Title>

          <header className="flex items-center justify-between gap-3 border-b px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <p className="text-foreground min-w-0 truncate text-sm font-medium">{title}</p>
            <p role="timer" aria-label={s.liveElapsed} className="text-muted-foreground text-sm tabular-nums">
              {formatElapsed(elapsed)}
            </p>
          </header>

          <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-6 overflow-y-auto px-5 py-6">
            <div className="flex flex-col items-center gap-3 pt-2 text-center">
              <span
                aria-hidden="true"
                className={cn(
                  "relative grid size-24 place-items-center rounded-full",
                  live.problem
                    ? "bg-destructive-soft text-destructive-soft-foreground"
                    : live.muted
                      ? "bg-muted text-muted-foreground"
                      : "bg-accent text-accent-foreground",
                )}
              >
                {phase === "listening" && !live.muted && !live.problem ? (
                  <span
                    className="bg-primary/20 absolute inset-0 rounded-full motion-safe:animate-ping"
                    style={{ animationDuration: "2.4s" }}
                  />
                ) : null}
                <Icon
                  className={cn(
                    "relative size-10",
                    (phase === "connecting" || phase === "thinking") && !live.muted
                      ? "motion-safe:animate-spin"
                      : "",
                  )}
                />
              </span>
              <p role="status" className="flex items-center gap-3 text-xl font-semibold">
                {live.muted ? s.liveMuted : statusLabel(phase)}
                {phase === "listening" && !live.muted ? <LevelMeter level={live.level} /> : null}
              </p>
            </div>

            <section aria-label={s.liveInterviewerSays} className="grid gap-2">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {s.liveInterviewerSays}
              </p>
              {/* Not a live region: it is replaced as a whole, and `announcer` below says it once. */}
              <p aria-live="off" className="text-foreground text-xl leading-snug text-balance">
                {interviewer?.content ?? ""}
              </p>
              <p role="status" className="sr-only">
                {announcement}
              </p>
            </section>

            {options.length > 0 ? (
              <fieldset className="grid gap-2">
                <legend className="text-muted-foreground mb-1 text-xs">{s.liveOptionsHint}</legend>
                {options.map((o) => (
                  <ChoiceTile key={o.key} compact className="min-h-12 items-center">
                    <input
                      type="radio"
                      name="live-widget"
                      className="accent-primary size-4"
                      checked={false}
                      onChange={() => {
                        onAnswer(o.response);
                      }}
                    />
                    <span className="text-foreground text-base">{o.label}</span>
                  </ChoiceTile>
                ))}
              </fieldset>
            ) : null}

            <section aria-label={s.liveYouSaid} className="grid gap-2">
              {live.captions && !live.partial && !reply?.content ? null : (
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {s.liveYouSaid}
                </p>
              )}
              {live.captions ? (
                <p aria-live="off" className="text-base leading-snug [overflow-wrap:anywhere]">
                  {live.partial ? (
                    <span className="italic">{live.partial}</span>
                  ) : (
                    <span className="text-muted-foreground">{reply?.content ?? ""}</span>
                  )}
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">{s.liveNoCaptions}</p>
              )}
              {live.notHeard ? (
                <p role="status" className="text-sm">
                  {s.liveNotHeard}
                </p>
              ) : null}
              {live.textOnly ? (
                <p role="status" className="text-muted-foreground text-sm">
                  {s.liveTextOnly}
                </p>
              ) : null}
              {live.problem ? (
                <p
                  role="alert"
                  className="bg-destructive-soft text-destructive-soft-foreground rounded-xl px-3 py-2.5 text-sm"
                >
                  {problemMessage(live.problem)}
                </p>
              ) : null}
            </section>

            {showAll ? (
              <section aria-label={s.liveConversation}>
                <ol className="grid gap-3 text-sm">
                  {spoken.slice(-12).map((m) => (
                    <li key={m.id} className={cn(m.role === "user" && "text-muted-foreground pl-4")}>
                      <span className="sr-only">
                        {m.role === "user" ? s.liveYouSaid : s.liveInterviewerSays}:{" "}
                      </span>
                      {m.content}
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
          </div>

          <footer className="grid gap-2 border-t px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <div className="mx-auto grid w-full max-w-2xl gap-2">
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-14 px-2 py-2 text-base leading-tight whitespace-normal"
                  aria-pressed={live.muted}
                  onClick={() => {
                    live.setMuted(!live.muted);
                  }}
                >
                  {live.muted ? (
                    <MicOffIcon className="size-5" aria-hidden="true" />
                  ) : (
                    <MicIcon className="size-5" aria-hidden="true" />
                  )}
                  {live.muted ? s.liveUnmute : s.liveMute}
                </Button>
                {live.status === "speaking" ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-14 text-base"
                    onClick={live.stopSpeaking}
                  >
                    <SquareIcon className="size-5" aria-hidden="true" />
                    {s.liveStopSpeaking}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-14 text-base"
                    onClick={() => {
                      setShowAll((v) => !v);
                    }}
                    aria-expanded={showAll}
                  >
                    {showAll ? s.liveHideConversation : s.liveShowConversation}
                  </Button>
                )}
              </div>
              <Button
                ref={endRef}
                type="button"
                variant="destructive"
                className="min-h-14 w-full text-base"
                onClick={live.end}
              >
                <PhoneOffIcon className="size-5" aria-hidden="true" />
                {s.liveEnd}
              </Button>
              <Button type="button" variant="ghost" className="min-h-11" onClick={onTypeInstead}>
                <KeyboardIcon className="size-4" aria-hidden="true" />
                {s.liveTypeInstead}
              </Button>
            </div>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
