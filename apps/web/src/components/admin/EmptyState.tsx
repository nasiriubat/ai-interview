import { InboxIcon } from "lucide-react";
import * as React from "react";

export function EmptyState({
  text,
  icon: Icon = InboxIcon,
  children,
}: {
  text: string;
  icon?: typeof InboxIcon;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="bg-card shadow-card flex flex-col items-center rounded-lg px-6 py-12 text-center">
      <span className="bg-accent text-accent-foreground mb-3 grid size-10 place-items-center rounded-full">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <p className="text-muted-foreground max-w-sm text-sm">{text}</p>
      {children ? <div className="mt-4 flex justify-center gap-2">{children}</div> : null}
    </div>
  );
}
