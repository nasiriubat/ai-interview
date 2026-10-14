"use client";

import { FlagIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import { formatDate } from "@/lib/utils";

/**
 * The top of an interview that the engine flagged (D-173): what was noticed, when it is allowed
 * to say what, and the one action, acknowledging that a person has looked. The reason is model
 * prose about the participant, so the API sends it only to someone who may read the transcript;
 * everyone else is told that it is hidden rather than shown nothing.
 */
export function FlagCallout({
  sessionId,
  reason,
  acknowledgedAt,
  canAcknowledge,
}: {
  sessionId: string;
  reason: string | null | undefined;
  acknowledgedAt: string | null | undefined;
  /** Acknowledging is an admin action; a member sees the flag without the button. */
  canAcknowledge: boolean;
}): React.JSX.Element {
  const s = t.admin.sessions;
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const acknowledge = async (): Promise<void> => {
    setBusy(true);
    setFailed(false);
    try {
      await staffClient.sessions.acknowledgeFlag(sessionId);
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Alert variant={acknowledgedAt ? "default" : "warning"}>
      <FlagIcon aria-hidden="true" />
      <AlertTitle>{s.flagTitle}</AlertTitle>
      <AlertDescription>
        <p>{s.flagBody}</p>
        <p>
          <span className="font-medium">{s.flagReasonLabel}: </span>
          {reason?.trim() ? reason : s.flagReasonHidden}
        </p>
        {acknowledgedAt ? (
          <p>{s.flagAcked(formatDate(acknowledgedAt))}</p>
        ) : canAcknowledge ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                void acknowledge();
              }}
            >
              {s.flagAck}
            </Button>
            {failed ? (
              <span role="alert" className="text-destructive text-sm">
                {s.flagAckFailed}
              </span>
            ) : null}
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
