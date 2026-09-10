import { AlertTriangleIcon } from "lucide-react";
import * as React from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { t } from "@/i18n";
import { errorMessage } from "@/lib/api/errors";

/** Shown when a server component could not load part of a page. The rest of the page still renders. */
export function LoadError({ error, title }: { error: unknown; title?: string }): React.JSX.Element {
  return (
    <Alert variant="destructive">
      <AlertTriangleIcon />
      <AlertTitle>{title ?? t.admin.common.loadFailed}</AlertTitle>
      <AlertDescription>{errorMessage(error, t.app.unknownError)}</AlertDescription>
    </Alert>
  );
}

/** Helper for `Promise.allSettled` results. */
export function settled<T>(
  r: PromiseSettledResult<T>,
): { data: T; error: null } | { data: null; error: unknown } {
  return r.status === "fulfilled" ? { data: r.value, error: null } : { data: null, error: r.reason };
}
