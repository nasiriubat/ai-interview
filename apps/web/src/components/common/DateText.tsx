"use client";

import * as React from "react";
import { formatDate } from "@/lib/utils";

/**
 * A date rendered in the viewer's locale and timezone. The server renders it in its own
 * timezone, so the text legitimately differs after hydration; the warning is suppressed
 * for this element only.
 */
export function DateText({
  iso,
  className,
}: {
  iso: string | null | undefined;
  className?: string;
}): React.JSX.Element {
  return (
    <time dateTime={iso ?? undefined} suppressHydrationWarning {...(className ? { className } : {})}>
      {formatDate(iso)}
    </time>
  );
}
