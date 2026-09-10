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
  error: Error;
  reset: () => void;
}): React.JSX.Element {
  React.useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <StatusScreen
      icon={<AlertTriangleIcon />}
      tone="warning"
      title={t.participant.session.errorProviderTitle}
      body={t.participant.session.errorProviderBody}
    >
      <Button
        onClick={() => {
          reset();
        }}
      >
        {t.app.retry}
      </Button>
    </StatusScreen>
  );
}
