"use client";

import { BracesIcon } from "lucide-react";
import * as React from "react";
import { IconButton } from "@/components/admin/IconButton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";

/**
 * What an audit entry recorded, as formatted JSON, behind an icon button: the table stays one
 * line per entry and the detail is one click away, with a name that says which entry it is.
 */
export function AuditDetails({
  action,
  when,
  details,
}: {
  action: string;
  when: string;
  details: unknown;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const s = t.admin.audit;
  return (
    <>
      <IconButton
        label={`${s.showDetails}: ${action}`}
        icon={<BracesIcon />}
        onClick={() => {
          setOpen(true);
        }}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={t.app.close} className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-base">{action}</DialogTitle>
            <DialogDescription>{when}</DialogDescription>
          </DialogHeader>
          <pre className="bg-muted max-h-[50dvh] overflow-auto rounded-md p-3 text-xs break-words whitespace-pre-wrap">
            {JSON.stringify(details, null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}
