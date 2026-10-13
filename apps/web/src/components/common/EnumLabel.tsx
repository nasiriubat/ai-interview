import * as React from "react";
import { hasLabel, label, type EnumKind } from "@/lib/i18n/enums";

/**
 * An identifier from the API in the reader's language. One nobody has named yet is shown as
 * code, so it reads as an identifier rather than as a translated word.
 */
export function EnumLabel({
  kind,
  value,
  className,
}: {
  kind: EnumKind;
  value: string;
  className?: string;
}): React.JSX.Element {
  if (hasLabel(kind, value)) return <span className={className}>{label(kind, value)}</span>;
  return <code className={className ? `${className} font-mono text-xs` : "font-mono text-xs"}>{value}</code>;
}
