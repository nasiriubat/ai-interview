import * as React from "react";
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
    <main
      id="main"
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-4 p-6 text-center"
    >
      {icon ? (
        <div
          aria-hidden="true"
          className={cn(
            "flex size-14 items-center justify-center rounded-full",
            tone === "warning" && "bg-amber-100 text-amber-800",
            tone === "success" && "bg-emerald-100 text-emerald-800",
            tone === "neutral" && "bg-muted text-foreground",
          )}
        >
          {icon}
        </div>
      ) : null}
      <h1 className="text-2xl font-semibold text-balance">{title}</h1>
      <p className="text-muted-foreground text-balance">{body}</p>
      {children ? <div className="mt-2 flex flex-wrap justify-center gap-2">{children}</div> : null}
    </main>
  );
}
