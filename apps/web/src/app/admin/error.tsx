"use client";

import Link from "next/link";
import * as React from "react";
import { StateView } from "@/components/common/StateView";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { reportBrowserError } from "@/lib/errors/browser-report";

/** A page under `/admin` failed: the shell stays, only the content is replaced. */
export default function AdminError({
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
  const s = t.kit.states;
  return (
    <StateView
      size="panel"
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
            <Link href="/admin">{s.backHome}</Link>
          </Button>
        </>
      }
      detail={error.digest ? s.error.reference(error.digest) : null}
    />
  );
}
