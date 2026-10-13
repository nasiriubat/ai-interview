"use client";

import { ListChecksIcon, MessageSquareTextIcon, MicIcon } from "lucide-react";
import { ToggleGroup } from "radix-ui";
import * as React from "react";
import { t } from "@/i18n";
import type { ModePreference } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

const MODES: readonly ModePreference[] = ["chat", "options", "voice"];

/**
 * Chat, options, or voice (FR-30: voice makes the microphone the primary way to answer).
 * Voice is offered only when the session's capabilities say this tenant records at all.
 *
 * A Radix toggle group with one selected value: the group is one tab stop, the arrow keys move
 * focus between the items (looping) and Space or Enter chooses. Arrow keys deliberately do not
 * choose: picking voice starts a call, which must not happen as a side effect of passing over it.
 * Each item carries its name as `aria-label`, so the icon-only phone layout still has one.
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
  const s = t.participant.session;
  const item = (value: ModePreference, label: string, Icon: typeof MicIcon): React.JSX.Element => (
    <ToggleGroup.Item
      key={value}
      value={value}
      aria-label={label}
      className={cn(
        "inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
        mode === value
          ? "bg-card text-primary shadow-control"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      {/* Icon-only on a phone, where the header has no room for three words; the name stays. */}
      <span aria-hidden="true" className="hidden sm:inline">
        {label}
      </span>
    </ToggleGroup.Item>
  );
  const labels: Record<ModePreference, [string, typeof MicIcon]> = {
    chat: [s.modeChat, MessageSquareTextIcon],
    options: [s.modeOptions, ListChecksIcon],
    voice: [s.modeVoice, MicIcon],
  };
  return (
    <ToggleGroup.Root
      type="single"
      value={mode}
      // Clicking the selected item reports an empty value; a mode is always chosen.
      onValueChange={(v) => {
        if (MODES.includes(v as ModePreference)) onChange(v as ModePreference);
      }}
      aria-label={s.modeLabel}
      rovingFocus
      loop
      className="bg-muted inline-flex rounded-lg p-0.5"
    >
      {MODES.filter((m) => m !== "voice" || voiceEnabled).map((m) => item(m, ...labels[m]))}
    </ToggleGroup.Root>
  );
}
