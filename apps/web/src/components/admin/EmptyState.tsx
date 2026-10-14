import { InboxIcon } from "lucide-react";
import * as React from "react";
import { Illustration, type IllustrationName } from "@/components/ui/illustrations";

/**
 * An empty area inside a page. Pass `illustration` (and `title`) for a first-run state that should
 * teach what goes here; `icon` alone keeps the quiet one-line form for minor lists.
 */
export function EmptyState({
  text,
  title,
  illustration,
  icon: Icon = InboxIcon,
  children,
}: {
  text: string;
  title?: string;
  illustration?: IllustrationName;
  icon?: typeof InboxIcon;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="bg-card shadow-card flex flex-col items-center rounded-lg px-6 py-12 text-center">
      {illustration ? (
        <Illustration name={illustration} className="mb-2 w-36" />
      ) : (
        <span className="bg-accent text-accent-foreground mb-3 grid size-10 place-items-center rounded-full">
          <Icon className="size-5" aria-hidden="true" />
        </span>
      )}
      {title ? <p className="text-foreground mb-1 text-base font-semibold tracking-tight">{title}</p> : null}
      <p className="text-muted-foreground max-w-sm text-sm">{text}</p>
      {children ? <div className="mt-4 flex flex-wrap justify-center gap-2">{children}</div> : null}
    </div>
  );
}
