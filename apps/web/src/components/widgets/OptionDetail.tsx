"use client";

import { ChevronDownIcon } from "lucide-react";
import * as React from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/** The expandable detail behind a choice option. Renders nothing when there is no detail. */
export function OptionDetail({
  id,
  label,
  detail,
}: {
  id: string;
  label: string;
  detail: string | undefined;
}): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  if (!detail) return null;
  return (
    <div className="mt-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={t.participant.session.widgetDetail(label)}
        className="text-muted-foreground hover:text-foreground inline-flex min-h-8 items-center gap-1 text-xs"
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <ChevronDownIcon
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
        {t.participant.session.widgetDetail(label)}
      </button>
      <p id={id} hidden={!open} className="text-muted-foreground mt-1 text-sm">
        {detail}
      </p>
    </div>
  );
}
