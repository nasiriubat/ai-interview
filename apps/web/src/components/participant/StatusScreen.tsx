import * as React from "react";
import { ParticipantPage } from "./ParticipantFrame";
import { PageHeading } from "@/components/common/PageHeading";
import { cn } from "@/lib/utils";

/** A full-screen state: paused, deleted, closed, expired, error. */
export function StatusScreen({
  icon,
  title,
  body,
  children,
  note,
  tone = "neutral",
  identity,
}: {
  icon?: React.ReactNode;
  title: string;
  body: string;
  children?: React.ReactNode;
  /** A short block under the body, such as the resume recap on the paused screen. */
  note?: React.ReactNode;
  tone?: "neutral" | "warning" | "success";
  /** The name in the header, when the screen knows it (the interview's own name). */
  identity?: string | undefined;
}): React.JSX.Element {
  return (
    <ParticipantPage title={identity} className="flex flex-col items-center gap-4 py-10 text-center sm:py-12">
      {icon ? (
        <div
          aria-hidden="true"
          className={cn(
            "flex size-16 items-center justify-center rounded-full [&_svg]:size-7",
            tone === "warning" && "bg-warning-soft text-warning-soft-foreground",
            tone === "success" && "bg-success-soft text-success-soft-foreground",
            tone === "neutral" && "bg-accent text-accent-foreground",
          )}
        >
          {icon}
        </div>
      ) : null}
      <PageHeading focusOnMount>{title}</PageHeading>
      <p className="text-muted-foreground text-balance">{body}</p>
      {note ? (
        <div className="bg-card shadow-card max-w-prose rounded-xl p-4 text-left text-sm">{note}</div>
      ) : null}
      {children ? <div className="mt-3 flex flex-wrap justify-center gap-2">{children}</div> : null}
    </ParticipantPage>
  );
}
