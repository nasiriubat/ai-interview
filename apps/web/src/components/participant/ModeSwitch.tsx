"use client";

import { ListChecksIcon, MessageSquareTextIcon, MicIcon } from "lucide-react";
import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import type { ModePreference } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

/** Chat, options, or voice. Voice is a placeholder until phase 4. */
export function ModeSwitch({
  mode,
  onChange,
}: {
  mode: ModePreference;
  onChange: (mode: ModePreference) => void;
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
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="inline-flex rounded-md"
            aria-label={t.participant.session.modeVoiceDisabled}
          >
            <button
              type="button"
              role="radio"
              aria-checked={false}
              disabled
              aria-disabled="true"
              className="text-muted-foreground inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium opacity-50"
            >
              <MicIcon className="size-3.5" aria-hidden="true" />
              {t.participant.session.modeVoice}
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t.app.comingPhase4}</TooltipContent>
      </Tooltip>
    </div>
  );
}
