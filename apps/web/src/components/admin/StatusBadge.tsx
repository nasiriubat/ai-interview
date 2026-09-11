import * as React from "react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { humanize } from "@/lib/utils";

const TONES: Record<string, BadgeProps["variant"]> = {
  open: "success",
  active: "success",
  published: "success",
  completed: "success",
  accepted: "success",
  sent: "secondary",
  pending: "secondary",
  draft: "secondary",
  created: "secondary",
  consented: "secondary",
  paused: "warning",
  opened: "warning",
  closed: "outline",
  archived: "outline",
  expired: "outline",
  revoked: "destructive",
  deleted: "destructive",
  suspended: "destructive",
  error: "destructive",
  // Spec versions and findings (contract 18)
  done: "success",
  queued: "secondary",
  running: "warning",
  failed: "destructive",
  raised: "warning",
  resolved: "success",
  deferred: "outline",
};

export function StatusBadge({ status }: { status: string | null | undefined }): React.JSX.Element {
  const s = status ?? "unknown";
  return <Badge variant={TONES[s] ?? "outline"}>{humanize(s)}</Badge>;
}
