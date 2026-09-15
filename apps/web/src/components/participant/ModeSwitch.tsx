"use client";

import { ListChecksIcon, MessageSquareTextIcon, MicIcon } from "lucide-react";
import * as React from "react";
import { t } from "@/i18n";
import type { ModePreference } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

/**
 * Chat, options, or voice (FR-30: voice makes the microphone the primary way to answer).
 * Voice is offered only when the session's capabilities say this tenant records at all.
 */
export function ModeSwitch({
  mode,
  onChange,
  voiceEnabled,
}: {
  mode: ModePreference;
  onChange: (mode: ModePreference) => void;
  voiceEnabled: boolean;
}): React.JSX.Element {
  const item = (value: ModePreference, label: string, Icon: typeof MicIcon): React.JSX.Element => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
        mode === value
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={() => {
        onChange(value);
      }}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </button>
  );
  return (
    <div
      role="radiogroup"
      aria-label={t.participant.session.modeLabel}
      className="bg-muted inline-flex rounded-lg p-0.5"
    >
      {item("chat", t.participant.session.modeChat, MessageSquareTextIcon)}
      {item("options", t.participant.session.modeOptions, ListChecksIcon)}
      {voiceEnabled ? item("voice", t.participant.session.modeVoice, MicIcon) : null}
    </div>
  );
}
