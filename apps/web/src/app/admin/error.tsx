"use client";

import * as React from "react";
import { LoadError } from "@/components/admin/LoadError";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export default function AdminError({ error, reset }: { error: Error; reset: () => void }): React.JSX.Element {
  React.useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="grid max-w-xl gap-3">
      <LoadError error={error} title={t.app.errorTitle} />
      <div>
        <Button
          onClick={() => {
            reset();
          }}
        >
          {t.app.retry}
        </Button>
      </div>
    </div>
  );
}
