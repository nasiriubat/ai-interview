"use client";

import Link from "next/link";
import * as React from "react";
import { AuthShell } from "@/components/common/AuthShell";
import { useBranding } from "@/components/common/Branding";
import { StateView } from "@/components/common/StateView";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/** The error boundary of every page outside `/admin` (which has its own, inside the shell). */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  React.useEffect(() => {
    console.error(error);
  }, [error]);
  const s = t.kit.states;
  const { productName } = useBranding();
  return (
    <AuthShell variant="centered">
      <StateView
        illustration="error"
        code={s.code(500)}
        title={s.error.title}
        body={s.error.body}
        actions={
          <>
            <Button
              onClick={() => {
                reset();
              }}
            >
              {t.app.retry}
            </Button>
            <Button asChild variant="outline">
              <Link href="/">{productName}</Link>
            </Button>
          </>
        }
        detail={error.digest ? s.error.reference(error.digest) : null}
      />
    </AuthShell>
  );
}
