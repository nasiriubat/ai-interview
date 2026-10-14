import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A selectable row or tile that wraps a radio or a checkbox (D-110). The boundary is the 3:1
 * `--input` token through `shadow-control`, so an unselected tile is a visible target; a selected
 * one gets a 2px primary ring and the accent fill, so selection is not carried by colour alone
 * (the control inside is checked too). Keyboard focus comes from the inner control: the tile
 * outlines itself while it contains the focus-visible element.
 *
 * It renders a `<label>`: a click anywhere on the tile toggles the control, and the control's
 * accessible name is the tile's text.
 */
export function ChoiceTile({
  className,
  compact = false,
  disabled = false,
  ...props
}: React.ComponentProps<"label"> & { compact?: boolean; disabled?: boolean }): React.JSX.Element {
  return (
    <label
      data-slot="choice-tile"
      data-disabled={disabled ? "true" : undefined}
      className={cn(
        "bg-card shadow-control flex cursor-pointer items-start gap-3 rounded-lg transition-shadow",
        "hover:shadow-[0_0_0_1px_var(--input-hover)]",
        "has-[:checked]:bg-accent has-[:checked]:shadow-[0_0_0_2px_var(--primary)]",
        "has-[:focus-visible]:outline-ring has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2",
        "data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-60",
        compact ? "p-2" : "p-3",
        className,
      )}
      {...props}
    />
  );
}
