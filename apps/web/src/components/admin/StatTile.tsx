import * as React from "react";
import { Card } from "@/components/ui/card";

export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string | undefined;
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }> | undefined;
}): React.JSX.Element {
  return (
    <Card className="gap-0 px-5 py-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-[13px] font-medium">{label}</p>
        {Icon ? <Icon className="text-primary/70 size-4" aria-hidden="true" /> : null}
      </div>
      <p className="text-foreground mt-2 text-[1.75rem] leading-none font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      {hint ? <p className="text-muted-foreground mt-2 text-xs">{hint}</p> : null}
    </Card>
  );
}
