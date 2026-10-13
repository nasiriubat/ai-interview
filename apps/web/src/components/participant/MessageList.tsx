"use client";

import { SquareIcon, Volume2Icon } from "lucide-react";
import * as React from "react";
import type { Speech } from "@/hooks/useSpeech";
import { t } from "@/i18n";
import type { Message } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

export function TypingIndicator(): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-1 px-1 py-2"
      role="status"
      aria-label={t.participant.session.typing}
    >
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

/** The conversation. New interviewer messages are announced politely to screen readers. */
export function MessageList({
  messages,
  streaming,
  pending,
  speech,
  children,
}: {
  messages: Message[];
  streaming: string | null;
  pending: boolean;
  speech?: Speech | undefined;
  children?: React.ReactNode;
}): React.JSX.Element {
  const endRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, streaming, pending]);

  const visible = messages.filter((m) => m.role !== "system");
  return (
    <div className="flex flex-col gap-3" aria-label={t.participant.session.messagesLabel} role="log">
      {visible.map((m) => (
        <MessageBubble key={m.id} message={m} speech={speech} />
      ))}
      <div aria-live="polite" aria-atomic="false">
        {streaming !== null ? (
          <MessageBubble message={{ role: "assistant", content: streaming }} streaming />
        ) : null}
        {pending && streaming === null ? <TypingIndicator /> : null}
      </div>
      {children}
      <div ref={endRef} />
    </div>
  );
}
