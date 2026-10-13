import * as React from "react";
import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("bg-[#e8edf3] motion-safe:animate-pulse rounded-md", className)}
      {...props}
    />
  );
}
