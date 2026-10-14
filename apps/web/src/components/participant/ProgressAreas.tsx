"use client";

import { CheckIcon, CircleDashedIcon, CircleDotIcon, SkipForwardIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import type { ProgressArea } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

const ICONS: Record<ProgressArea["status"], typeof CheckIcon> = {
  untouched: CircleDashedIcon,
  partial: CircleDotIcon,
  covered: CheckIcon,
  skipped: SkipForwardIcon,
};

/** The topics as a checklist. Tap a topic to skip it or come back to it. */
export function ProgressAreas({
  areas,
  disabled,
  onSkip,
  onReturn,
}: {
  areas: ProgressArea[];
  disabled: boolean;
  onSkip: (area: ProgressArea) => void;
  onReturn: (area: ProgressArea) => void;
}): React.JSX.Element | null {
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  if (areas.length === 0) return null;
  const done = areas.filter((a) => a.status === "covered").length;

  return (
    <nav aria-label={t.participant.session.progressLabel} className="w-full">
      <span className="sr-only">{t.admin.campaigns.areasCovered(done, areas.length)}</span>
      <ol className="grid gap-1">
        {areas.map((a) => {
          const Icon = ICONS[a.status];
          const statusLabel = t.participant.session.progressStatus[a.status];
          return (
            <li key={a.key}>
              <Popover
                open={openKey === a.key}
                onOpenChange={(o) => {
                  setOpenKey(o ? a.key : null);
                }}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${a.name}: ${statusLabel}. ${t.participant.session.areaActions(a.name)}`}
                    className={cn(
                      "hover:bg-muted flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors",
                      a.status === "partial" && "bg-accent/60",
                      a.status === "skipped" && "text-muted-foreground",
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        a.status === "covered" ? "text-success" : "text-muted-foreground",
                      )}
                      aria-hidden="true"
                    />
                    <span className={cn("min-w-0 flex-1", a.status === "skipped" && "line-through")}>
                      {a.name}
                    </span>
                    {a.status !== "untouched" ? (
                      <span className="text-muted-foreground shrink-0 text-xs">{statusLabel}</span>
                    ) : null}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-56 p-2">
                  <p className="text-muted-foreground px-2 pb-1 text-xs">{statusLabel}</p>
                  <div className="grid gap-1">
                    {a.status !== "covered" && a.status !== "skipped" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-10 justify-start"
                        disabled={disabled}
                        onClick={() => {
                          setOpenKey(null);
                          onSkip(a);
                        }}
                      >
                        {t.participant.session.skipArea}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-10 justify-start"
                      disabled={disabled}
                      onClick={() => {
                        setOpenKey(null);
                        onReturn(a);
                      }}
                    >
                      {t.participant.session.returnToArea}
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
