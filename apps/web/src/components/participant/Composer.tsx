"use client";

import { SendHorizontalIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";

export function Composer({
  disabled,
  onSend,
  autoFocus = false,
}: {
  disabled: boolean;
  onSend: (text: string) => void;
  autoFocus?: boolean;
}): React.JSX.Element {
  const [text, setText] = React.useState("");
  const id = React.useId();
  const canSend = !disabled && text.trim().length > 0;

  const submit = (): void => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor={id} className="sr-only">
        {t.participant.session.composerLabel}
      </label>
      <Textarea
        id={id}
        value={text}
        rows={1}
        autoFocus={autoFocus}
        placeholder={t.participant.session.composerPlaceholder}
        className="max-h-40 min-h-11 flex-1 resize-none text-base"
        enterKeyHint="send"
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <Button
        type="submit"
        size="icon"
        className="size-11 shrink-0"
        disabled={!canSend}
        aria-label={t.participant.session.send}
      >
        <SendHorizontalIcon className="size-5" />
      </Button>
    </form>
  );
}
