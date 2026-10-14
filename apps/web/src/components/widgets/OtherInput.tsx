"use client";

import { LoaderCircleIcon, MicIcon, SquareIcon } from "lucide-react";
import * as React from "react";
import { useWidgetVoice } from "./voice-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { recorderProblemMessage, useRecorder } from "@/hooks/useRecorder";
import { t } from "@/i18n";
import { participantErrorText } from "@/lib/api/errors";

type Phase = "idle" | "transcribing" | "filled";

/**
 * The always-present "Other" entry of choice widgets. It accepts typing, and speech where the
 * interview takes recorded voice (spec 06, D-239): the recording is turned into words that land in
 * this field as a draft. Nothing is sent until the participant submits the widget, so a wrong
 * transcript is one edit away from right.
 */
export function OtherInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
}): React.JSX.Element {
  const s = t.participant.session;
  const voice = useWidgetVoice();
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [failure, setFailure] = React.useState<string | null>(null);
  const valueRef = React.useRef(value);
  valueRef.current = value;
  const input = React.useRef<HTMLInputElement>(null);

  const recorder = useRecorder((audio, durationMs) => {
    if (!voice) return;
    setPhase("transcribing");
    setFailure(null);
    voice
      .transcribe(audio, durationMs)
      .then((text) => {
        const current = valueRef.current.trim();
        onChange(current ? `${current} ${text}` : text);
        setPhase("filled");
        input.current?.focus();
      })
      .catch((e: unknown) => {
        setPhase("idle");
        setFailure(participantErrorText(e, "interview"));
      });
  });

  const recording = recorder.status === "recording";
  const starting = recorder.status === "starting";
  const problem = recorder.problem ? recorderProblemMessage(recorder.problem) : failure;

  return (
    <div className="mt-3 grid gap-1.5">
      <Label htmlFor={id}>{s.widgetOther}</Label>
      <div className="flex gap-2">
        <Input
          ref={input}
          id={id}
          value={value}
          disabled={disabled}
          placeholder={s.widgetOtherPlaceholder}
          autoComplete="off"
          aria-describedby={`${id}-status`}
          onChange={(e) => {
            onChange(e.target.value);
            if (phase === "filled") setPhase("idle");
          }}
        />
        {voice ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0"
            disabled={(disabled ?? false) || starting || phase === "transcribing"}
            aria-label={recording ? s.widgetOtherStop : s.widgetOtherSpeak}
            aria-pressed={recording}
            onClick={() => {
              if (recording) recorder.stop();
              else void recorder.start();
            }}
          >
            {phase === "transcribing" || starting ? (
              <LoaderCircleIcon className="motion-safe:animate-spin" aria-hidden="true" />
            ) : recording ? (
              <SquareIcon aria-hidden="true" />
            ) : (
              <MicIcon aria-hidden="true" />
            )}
          </Button>
        ) : null}
      </div>
      <p id={`${id}-status`} role="status" className="text-muted-foreground min-h-4 text-xs">
        {recording
          ? s.widgetOtherRecording
          : phase === "transcribing"
            ? s.widgetOtherTranscribing
            : phase === "filled"
              ? s.widgetOtherFilled
              : ""}
      </p>
      {problem ? (
        <p role="alert" className="text-destructive text-xs">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
