"use client";

import { AlertTriangleIcon } from "lucide-react";
import * as React from "react";
import { StatusScreen } from "@/components/participant/StatusScreen";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export default function ParticipantError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  React.useEffect(() => {
    console.error(error);
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
