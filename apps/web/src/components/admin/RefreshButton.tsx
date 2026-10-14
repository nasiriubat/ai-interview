"use client";

import { RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/** Asks the server for the page again: for a status page that is read, not live (D-377). */
export function RefreshButton(): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <Button
      variant="outline"
      loading={pending}
      onClick={() => {
        startTransition(() => {
          router.refresh();
        });
      }}
    >
      <RefreshCwIcon aria-hidden="true" /> {t.ws.health.refresh}
    </Button>
  );
}
