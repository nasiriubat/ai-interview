import * as React from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">): React.JSX.Element {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "bg-card text-foreground shadow-control placeholder:text-muted-foreground focus-visible:ring-ring/40 focus-visible:shadow-[0_0_0_1px_var(--primary)] aria-invalid:ring-destructive/20 aria-invalid:shadow-[0_0_0_1px_var(--destructive)] flex field-sizing-content min-h-16 w-full rounded-md border-0 px-3 py-2 text-base transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}
