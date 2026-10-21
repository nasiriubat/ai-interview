"use client";

import { AlertTriangleIcon } from "lucide-react";
import * as React from "react";
import { StatusScreen } from "@/components/participant/StatusScreen";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { reportBrowserError } from "@/lib/errors/browser-report";

export default function ParticipantError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  React.useEffect(() => {
    console.error(error);
    // To the error log, once per page load (D-477).
    reportBrowserError(error, "boundary");
  }, [error]);
  return (
    <StatusScreen
      icon={<AlertTriangleIcon />}
      tone="warning"
      title={t.participant.session.errorServerTitle}
      body={t.participant.session.errorServerBody}
    >
      <Button
        onClick={() => {
          reset();
        }}
      >
        {t.app.retry}
      </Button>
      {error.digest ? (
        <p className="text-muted-foreground w-full text-xs">
          {t.participant.session.errorReference(error.digest)}
        </p>
      ) : null}
    </StatusScreen>
  );
}
