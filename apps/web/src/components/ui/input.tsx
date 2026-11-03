import * as React from "react";
import { cn } from "@/lib/utils";

export function Input({ className, type, ...props }: React.ComponentProps<"input">): React.JSX.Element {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground bg-card text-foreground shadow-control flex h-9 w-full min-w-0 rounded-md border-0 px-3 py-1 text-base transition-[color,box-shadow] file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "hover:shadow-[0_0_0_1px_var(--input-hover)] focus-visible:shadow-focus",
        "aria-invalid:ring-destructive/20 aria-invalid:shadow-[0_0_0_1px_var(--destructive)]",
        className,
      )}
      {...props}
    />
  );
}
