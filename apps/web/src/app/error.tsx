"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export default function GlobalError({
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
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <h1 className="text-2xl font-semibold">{t.app.errorTitle}</h1>
      <p className="text-muted-foreground">{t.app.errorBody}</p>
      <Button
        onClick={() => {
          reset();
        }}
      >
        {t.app.retry}
      </Button>
    </main>
  );
}
