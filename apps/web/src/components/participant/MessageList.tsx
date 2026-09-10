"use client";

import * as React from "react";
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
          className="motion-safe-bounce bg-muted-foreground/60 size-2 animate-bounce rounded-full"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}

export function MessageBubble({
  message,
  streaming = false,
}: {
  message: Pick<Message, "role" | "content">;
  streaming?: boolean;
}): React.JSX.Element {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap sm:max-w-[75%]",
          isUser ? "bg-primary text-primary-foreground rounded-br-md" : "bg-muted rounded-bl-md",
        )}
      >
        <span className="sr-only">
          {isUser ? t.participant.session.you : t.participant.session.interviewer}:{" "}
        </span>
        {message.content}
        {streaming ? <span className="sr-only"> ({t.participant.session.streaming})</span> : null}
      </div>
    </div>
  );
}

/** The conversation. New interviewer messages are announced politely to screen readers. */
export function MessageList({
  messages,
  streaming,
  pending,
  children,
}: {
  messages: Message[];
  streaming: string | null;
  pending: boolean;
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
        <MessageBubble key={m.id} message={m} />
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
