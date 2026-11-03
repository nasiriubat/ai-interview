"use client";

import { Loader2Icon } from "lucide-react";
import * as React from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Where a turn is, from the person's side (D-481):
 * - `thinking`: the answer went out and nothing has come back yet;
 * - `writing`: the question is streaming in;
 * - `preparing`: the question is complete and its options are being prepared (`event: composing`);
 * - `answer`: it is the person's turn, with options (`widget`) or without;
 * - `idle`: nothing to say (ended, or an error that has its own alert).
 */
export type TurnPhase = "thinking" | "writing" | "preparing" | "answer" | "idle";

export function turnPhase(state: {
  pending: boolean;
  streaming: string | null;
  composing: boolean;
  ended: boolean;
  error: unknown;
}): TurnPhase {
  if (state.ended || state.error) return "idle";
  if (!state.pending) return "answer";
  if (state.composing) return "preparing";
  return state.streaming !== null ? "writing" : "thinking";
}

/**
 * One line above the answer box that always says whose turn it is, so the seconds between the
 * question appearing and its options arriving never look stuck, and a question without options
 * plainly asks for a written answer. The line keeps its height in every phase, so the composer
 * never jumps. It is visual: a screen reader already hears each finished turn, options included,
 * from the message list's status region.
 */
export function TurnStatus({
  phase,
  widget,
  canDictate = false,
  className,
}: {
  phase: TurnPhase;
  widget: boolean;
  canDictate?: boolean;
  className?: string;
}): React.JSX.Element {
  const s = t.participant.session.turnStatus;
  const text =
    phase === "thinking"
      ? s.thinking
      : phase === "writing"
        ? s.writing
        : phase === "preparing"
          ? s.preparing
          : phase === "answer"
            ? widget
              ? s.pick
              : canDictate
                ? s.typeOrDictate
                : s.type
            : "";
  const busy = phase === "thinking" || phase === "writing" || phase === "preparing";
  return (
    <p
      aria-hidden="true"
      data-turn-phase={phase}
      className={cn(
        "flex h-5 min-w-0 items-center gap-1.5 px-1 text-xs",
        busy ? "text-muted-foreground" : "text-primary font-medium",
        className,
      )}
    >
      {busy ? <Loader2Icon className="size-3.5 shrink-0 motion-safe:animate-spin" /> : null}
      {/* Keyed on the phase so each change fades in rather than swapping words in place. */}
      <span
        key={phase}
        className="truncate motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300"
      >
        {text}
      </span>
    </p>
  );
}

/**
 * Focus the answer box when it becomes the person's turn to write, on a device with a keyboard,
 * and only when focus is nowhere in particular: someone reading the side panel or using a menu is
 * never pulled away. On a touch screen focusing would raise the keyboard over the question.
 */
export function useFocusOnTurn(phase: TurnPhase, widget: boolean, coarse: boolean, focus: () => void): void {
  const previous = React.useRef(phase);
  React.useEffect(() => {
    const was = previous.current;
    previous.current = phase;
    if (coarse || widget || phase !== "answer" || was === "answer" || was === "idle") return;
    const active = document.activeElement;
    if (active === null || active === document.body || active.closest("[data-chat-scroller]")) focus();
  }, [phase, widget, coarse, focus]);
}
