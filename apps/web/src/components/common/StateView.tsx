import * as React from "react";
import { Illustration, type IllustrationName } from "@/components/ui/illustrations";
import { cn } from "@/lib/utils";

/**
 * One state, said once: an illustration, a title, a sentence, and what to do next (D-391). Used for
 * the global states (404, 500, forbidden, expired, maintenance, suspended, offline) and, in
 * `panel` size, for an empty or failed area inside a page. `code` is the small label above the
 * title ("Error 404"); `detail` is a quiet line below the actions (a reference id, a hint).
 */
export function StateView({
  illustration,
  title,
  body,
  code,
  actions,
  detail,
  size = "page",
  headingLevel = 1,
  className,
}: {
  illustration: IllustrationName;
  title: string;
  body: string;
  code?: string | undefined;
  actions?: React.ReactNode;
  detail?: React.ReactNode;
  size?: "page" | "panel";
  headingLevel?: 1 | 2;
  className?: string | undefined;
}): React.JSX.Element {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const page = size === "page";
  return (
    <div
      className={cn(
        "flex flex-col items-center text-center",
        page ? "gap-4 py-8" : "bg-card shadow-card gap-3 rounded-lg px-6 py-12",
        className,
      )}
    >
      <Illustration name={illustration} className={page ? "w-48" : "w-36"} />
      {code ? <p className="text-primary text-xs font-semibold tracking-wide uppercase">{code}</p> : null}
      <Heading
        className={cn(
          "text-foreground font-semibold tracking-tight text-balance",
          page ? "text-2xl sm:text-3xl" : "text-lg",
        )}
      >
        {title}
      </Heading>
      <p className="text-muted-foreground max-w-md text-sm text-pretty sm:text-base">{body}</p>
      {actions ? <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div> : null}
      {detail ? <p className="text-muted-foreground mt-2 text-xs">{detail}</p> : null}
    </div>
  );
}
