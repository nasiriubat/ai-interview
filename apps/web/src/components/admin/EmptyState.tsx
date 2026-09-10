import * as React from "react";

export function EmptyState({
  text,
  children,
}: {
  text: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
      <p>{text}</p>
      {children ? <div className="mt-3 flex justify-center gap-2">{children}</div> : null}
    </div>
  );
}
