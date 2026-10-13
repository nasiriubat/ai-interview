import * as React from "react";
import { CenteredShell } from "@/components/common/CenteredShell";
import { cn } from "@/lib/utils";

/** A full-screen state: paused, deleted, closed, expired, error. */
export function StatusScreen({
  icon,
  title,
  body,
  children,
  tone = "neutral",
}: {
  icon?: React.ReactNode;
  title: string;
  body: string;
  children?: React.ReactNode;
  tone?: "neutral" | "warning" | "success";
}): React.JSX.Element {
  return (
    <CenteredShell className="flex flex-col items-center gap-4 text-center">
      {icon ? (
        <div
          aria-hidden="true"
          className={cn(
            "flex size-14 items-center justify-center rounded-full",
            tone === "warning" && "bg-warning-soft text-warning-soft-foreground",
            tone === "success" && "bg-success-soft text-success-soft-foreground",
            tone === "neutral" && "bg-accent text-accent-foreground",
          )}
        >
          {icon}
        </div>
      ) : null}
      <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance">{title}</h1>
      <p className="text-muted-foreground text-balance">{body}</p>
      {children ? <div className="mt-2 flex flex-wrap justify-center gap-2">{children}</div> : null}
    </CenteredShell>
  );
}
