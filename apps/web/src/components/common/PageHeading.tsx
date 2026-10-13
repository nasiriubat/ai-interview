"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The `h1` of a step or status screen. When a screen replaces another in place (the next step of
 * the arrival flow, a status after an action), the button that was clicked has just unmounted and
 * focus falls back to the top of the document; moving it to the new heading makes a screen reader
 * read where the person is now and lets a keyboard user continue from there.
 *
 * Not focused on the first screen of a page load: that would skip past the skip link.
 */
export function PageHeading({
  children,
  focusOnMount = false,
  className,
}: {
  children: React.ReactNode;
  focusOnMount?: boolean;
  className?: string | undefined;
}): React.JSX.Element {
  const ref = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (focusOnMount) ref.current?.focus();
    // Focus only when this heading appears; a later re-render must not pull focus back.
  }, []);
  return (
    <h1
      ref={ref}
      tabIndex={-1}
      className={cn(
        "text-foreground text-2xl font-semibold tracking-tight text-balance focus:outline-hidden",
        className,
      )}
    >
      {children}
    </h1>
  );
}
