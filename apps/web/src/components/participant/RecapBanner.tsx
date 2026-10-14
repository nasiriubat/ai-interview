"use client";

import { XIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/**
 * "Where you left off": two sentences shown above the conversation when a participant comes back
 * (spec 06, D-172). It is not a message: it sits outside the conversation list, is not announced as
 * one, and is gone for good once dismissed or once the participant answers.
 *
 * It is a region with its own heading, and focus lands on that heading when it appears, so a
 * keyboard or screen-reader user hears what it says before anything else. Continue hands focus on
 * to the answer box.
 */
export function RecapBanner({
  text,
  onContinue,
  onDismiss,
}: {
  text: string;
  onContinue: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const s = t.participant.session;
  const headingId = React.useId();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <section
      aria-labelledby={headingId}
      className="bg-card shadow-card mb-4 rounded-2xl border-l-4 border-l-[var(--primary)] p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-foreground text-sm font-semibold">
          {s.recapLabel}
        </h2>
        <Button type="button" variant="ghost" size="icon" aria-label={s.recapDismiss} onClick={onDismiss}>
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      <p className="text-foreground mt-1 text-[15px] leading-relaxed">{text}</p>
      <div className="mt-3">
        <Button type="button" size="sm" onClick={onContinue}>
          {s.recapContinue}
        </Button>
      </div>
    </section>
  );
}
