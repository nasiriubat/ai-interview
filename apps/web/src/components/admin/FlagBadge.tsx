import { FlagIcon } from "lucide-react";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";

/**
 * "Needs attention": an interview the engine flagged for hostility or distress (D-173). An icon
 * and words, never colour alone. Once somebody has acknowledged it the badge stays, quieter, so the
 * list still says which interviews were flagged.
 */
export function FlagBadge({ acknowledged }: { acknowledged: boolean }): React.JSX.Element {
  const s = t.admin.campaigns;
  return (
    <Badge variant={acknowledged ? "outline" : "warning"}>
      <FlagIcon aria-hidden="true" className="size-3" />
      {acknowledged ? s.flagBadgeAcked : s.flagBadge}
    </Badge>
  );
}
