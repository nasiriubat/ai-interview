import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The look of a selectable tile (D-110): the 3:1 `--input` boundary through `shadow-control`, and
 * a 2px primary ring with the accent fill when selected. Selection is not carried by colour alone:
 * the control inside is checked too, and `aria-pressed` or `aria-checked` says it for a button.
 *
 * `selected` is for tiles that are buttons (a path choice, a scale value). A tile that wraps a
 * native or Radix radio or checkbox does not need it: `has-[:checked]` and `has-[[data-state=checked]]`
 * find the control inside.
 */
export function choiceTileClass({
  selected = false,
  compact = false,
  disabled = false,
}: {
  selected?: boolean;
  compact?: boolean;
  disabled?: boolean;
} = {}): string {
  return cn(
    "bg-card shadow-control flex cursor-pointer items-start gap-3 rounded-lg transition-shadow",
    "hover:shadow-[0_0_0_1px_var(--input-hover)]",
    "has-[:checked]:bg-accent has-[:checked]:shadow-[0_0_0_2px_var(--primary)]",
    "has-[[data-state=checked]]:bg-accent has-[[data-state=checked]]:shadow-[0_0_0_2px_var(--primary)]",
    "has-[:focus-visible]:outline-ring has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2",
    selected && "bg-accent shadow-[0_0_0_2px_var(--primary)]",
    disabled && "cursor-not-allowed opacity-60",
    compact ? "p-2" : "p-3",
  );
}

/**
 * A selectable row or tile that wraps a radio or a checkbox. It renders a `<label>`, so a click
 * anywhere on the tile toggles the control and the control's accessible name is the tile's text.
 * A tile that holds its own label and extra content (an option with a detail line) is
 * `as="div"`, since a label cannot nest a label.
 */
export function ChoiceTile({
  as = "label",
  className,
  compact = false,
  disabled = false,
  ...props
}: Omit<React.ComponentProps<"label">, "ref"> & {
  as?: "label" | "div";
  compact?: boolean;
  disabled?: boolean;
}): React.JSX.Element {
  const Tag = as as "label";
  return (
    <Tag
      data-slot="choice-tile"
      data-disabled={disabled ? "true" : undefined}
      className={cn(choiceTileClass({ compact, disabled }), className)}
      {...props}
    />
  );
}
