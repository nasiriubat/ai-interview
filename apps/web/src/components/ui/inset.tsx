import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A grouping inside a Card or a Panel: a tinted block with no border and no shadow (D-110). It
 * replaces the ad-hoc `rounded border p-3` boxes, which put a 1.2:1 line around content that
 * needed no boundary at all. Never put an `Inset` in an `Inset`, or a Card in a Card.
 */
export function Inset({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return <div data-slot="inset" className={cn("bg-muted/50 rounded-lg p-3", className)} {...props} />;
}
