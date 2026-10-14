"use client";

import type { Widget } from "@aidp/shared";
import { SquareIcon, Volume2Icon } from "lucide-react";
import * as React from "react";
import { controlChipOf, type Announcement, type ControlChip } from "@/hooks/useInterview";
import { usePrefersReducedMotion } from "@/hooks/useMediaQuery";
import type { Speech } from "@/hooks/useSpeech";
import { t } from "@/i18n";
import type { Message } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

/** "Writing" is a status, so it carries its words as text: that is what a live region announces. */
export function TypingIndicator(): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 px-1 py-2" role="status">
      <span className="sr-only">{t.participant.session.typing}</span>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden="true"
          className="bg-primary/50 size-2 rounded-full motion-safe:animate-bounce"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}

export function MessageBubble({
  message,
  streaming = false,
  speech,
}: {
  message: Pick<Message, "role" | "content"> & { id?: string | undefined };
  streaming?: boolean;
  /** Offers "Listen" under interviewer messages when the browser can speak the language. */
  speech?: Speech | undefined;
}): React.JSX.Element {
  const isUser = message.role === "user";
  const listenable = !isUser && !streaming && speech?.supported === true && message.id !== undefined;
  const speaking = listenable && speech.speakingId === message.id;
  return (
    <div className={cn("flex flex-col", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap sm:max-w-[75%]",
          isUser
            ? "bg-primary text-primary-foreground rounded-br-md"
            : "bg-card text-foreground shadow-card rounded-bl-md",
        )}
      >
        <span className="sr-only">
          {isUser ? t.participant.session.you : t.participant.session.interviewer}:{" "}
        </span>
        {message.content}
        {streaming ? <span className="sr-only"> ({t.participant.session.streaming})</span> : null}
      </div>
      {listenable ? (
        <button
          type="button"
          aria-pressed={speaking}
          aria-label={speaking ? t.participant.session.stopListening : t.participant.session.listenTo}
          onClick={() => {
            if (speaking) speech.stop();
            else if (message.id !== undefined) speech.speak(message.id, message.content);
          }}
          className={cn(
            "mt-1 ml-1 inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium",
            speaking
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
        >
          {speaking ? (
            <SquareIcon className="size-3 fill-current" aria-hidden="true" />
          ) : (
            <Volume2Icon className="size-3.5" aria-hidden="true" />
          )}
          {speaking ? t.participant.session.stopListening : t.participant.session.listen}
        </button>
      ) : null}
    </div>
  );
}

/** What the chip for a control says: "You skipped Tools and systems". */
export function controlChipText(chip: ControlChip): string {
  const s = t.participant.session;
  const name = chip.areaName ?? chip.areaKey ?? "";
  switch (chip.kind) {
    case "skip_area":
      return s.controlSkipped(name);
    case "return_area":
      return s.controlReturned(name);
    case "finish":
      return s.controlFinished;
  }
}

/** One line that says a question has something to choose from, so a listener knows to look. */
export function widgetSummary(widget: Widget): string {
  const s = t.participant.session;
  switch (widget.type) {
    case "single_choice":
      return s.announceChoice(widget.options.length);
    case "multi_choice":
      return s.announceMulti(widget.options.length, widget.max);
    case "scale":
      return s.announceScale;
    case "ranking":
      return s.announceRanking(widget.options.length);
    case "yes_no":
      return s.announceYesNo;
  }
}

/** The text the announcer says for one completed interviewer turn. */
export function announcementText(a: Announcement): string {
  return a.widget ? `${a.text} ${widgetSummary(a.widget)}.` : a.text;
}

/**
 * The conversation.
 *
 * Screen readers hear a turn once, when it is complete. The list is a plain ordered list (not a
 * live `log`, which would read every token as it streams and then read the whole message again),
 * the streaming bubble is visual only (`aria-live="off"`), and one visually hidden status region
 * receives the finished interviewer text. The participant's own messages are never announced: they
 * typed them.
 */
export function MessageList({
  messages,
  streaming,
  pending,
  announcement,
  speech,
  children,
}: {
  messages: Message[];
  streaming: string | null;
  pending: boolean;
  /** The last completed interviewer turn; changes once per turn. */
  announcement?: Announcement | null | undefined;
  speech?: Speech | undefined;
  children?: React.ReactNode;
}): React.JSX.Element {
  const endRef = React.useRef<HTMLDivElement>(null);
  const reduceMotion = usePrefersReducedMotion();
  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: reduceMotion ? "auto" : "smooth" });
  }, [messages.length, streaming, pending, reduceMotion]);

  // A system message is not transcript; only the chips this screen made for a control are shown.
  const visible = messages.filter((m) => m.role !== "system" || controlChipOf(m) !== undefined);
  return (
    <div className="flex flex-col gap-3">
      <ol aria-label={t.participant.session.messagesLabel} className="flex flex-col gap-3">
        {visible.map((m) => {
          const chip = controlChipOf(m);
          return (
            <li key={m.id}>
              {chip ? (
                <p className="text-muted-foreground text-center text-xs">{controlChipText(chip)}</p>
              ) : (
                <MessageBubble message={m} speech={speech} />
              )}
            </li>
          );
        })}
      </ol>
      {streaming !== null ? (
        <div aria-live="off">
          <MessageBubble message={{ role: "assistant", content: streaming }} streaming />
        </div>
      ) : null}
      {pending && streaming === null ? <TypingIndicator /> : null}
      <p role="status" aria-atomic="true" className="sr-only">
        {announcement ? announcementText(announcement) : ""}
      </p>
      {children}
      <div ref={endRef} />
    </div>
  );
}
