import { cva, type VariantProps } from "class-variance-authority";
import { Loader2Icon } from "lucide-react";
import { Slot } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 aria-invalid:ring-destructive/20 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-button hover:bg-primary-hover",
        destructive: "bg-destructive text-white shadow-button hover:bg-destructive/90",
        outline: "bg-card text-foreground shadow-button hover:bg-muted",
        secondary: "bg-secondary text-foreground hover:bg-secondary-hover",
        ghost: "text-body hover:bg-muted hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 px-3 text-[13px] has-[>svg]:px-2.5",
        lg: "h-11 px-6 text-base has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean | undefined;
    /**
     * Shows a spinner in place of the leading icon and disables the button while an action runs,
     * so a second click cannot send it twice. `aria-busy` tells assistive tech why it is disabled.
     */
    loading?: boolean | undefined;
  };

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps): React.JSX.Element {
  const Comp = asChild ? Slot.Root : "button";
  if (asChild) {
    return (
      <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props}>
        {children}
      </Comp>
    );
  }
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }), loading && "[&>svg:not(.spinner)]:hidden")}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <Loader2Icon
          className="spinner motion-safe:animate-spin motion-reduce:opacity-60"
          aria-hidden="true"
        />
      ) : null}
      {children}
    </Comp>
  );
}

export { buttonVariants };
