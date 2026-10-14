import type { SolutionClass } from "@aidp/shared";

/**
 * One colour per solution class, from the chart tokens (D-371). Colour never carries the class
 * alone: every use prints the class name and the number beside the swatch. `none` is the quiet
 * grey because "leave it as it is" is the absence of a solution, not a fifth hue.
 */
export const CLASS_COLOR: Record<SolutionClass, string> = {
  ai: "var(--chart-1)",
  automation: "var(--chart-2)",
  software: "var(--chart-3)",
  process: "var(--chart-4)",
  none: "var(--muted-foreground)",
};
