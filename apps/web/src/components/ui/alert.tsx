import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const alertVariants = cva(
  "relative w-full rounded-lg border-0 px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default:
          "bg-info-soft text-info-soft-foreground *:data-[slot=alert-description]:text-info-soft-foreground/90",
        destructive:
          "bg-destructive-soft text-destructive-soft-foreground [&>svg]:text-current *:data-[slot=alert-description]:text-destructive-soft-foreground/90",
        warning:
          "bg-warning-soft text-warning-soft-foreground *:data-[slot=alert-description]:text-warning-soft-foreground/90",
        success:
          "bg-success-soft text-success-soft-foreground *:data-[slot=alert-description]:text-success-soft-foreground/90",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

/**
 * `alert` interrupts the screen reader and is for what blocks the person right now (a failed save, a
 * refused upload). `status` is announced politely and is for everything that is true but not urgent
 * (a degraded service, a note about the data). Overusing `alert` makes the urgent ones unheard.
 */
export type AlertRole = "alert" | "status";

export function Alert({
  className,
  variant,
  role = "alert",
  ...props
}: Omit<React.ComponentProps<"div">, "role"> &
  VariantProps<typeof alertVariants> & { role?: AlertRole }): React.JSX.Element {
  return (
    <div data-slot="alert" role={role} className={cn(alertVariants({ variant }), className)} {...props} />
  );
}

export function AlertTitle({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="alert-title"
      className={cn("col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight", className)}
      {...props}
    />
  );
}

export function AlertDescription({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-muted-foreground col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}
