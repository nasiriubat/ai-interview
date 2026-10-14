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

/** A small progress indicator by area. Tap an area to skip it or come back to it. */
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
      <div aria-hidden="true" className="flex items-center gap-2 pb-1.5">
        <div className="bg-muted h-1 flex-1 overflow-hidden rounded-full">
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-500"
            style={{ width: `${String(Math.round((done / areas.length) * 100))}%` }}
          />
        </div>
        <span className="text-foreground text-xs font-medium tabular-nums">
          {done}/{areas.length}
        </span>
      </div>
      <ol className="flex gap-1.5 overflow-x-auto py-1 [scrollbar-width:none]">
        {areas.map((a) => {
          const Icon = ICONS[a.status];
          const statusLabel = t.participant.session.progressStatus[a.status];
          return (
            <li key={a.key} className="shrink-0">
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
                      "shadow-control inline-flex h-9 items-center gap-1.5 rounded-full px-2.5 text-xs whitespace-nowrap transition-colors pointer-coarse:h-11",
                      a.status === "covered" && "bg-primary/10",
                      a.status === "partial" && "bg-accent",
                      a.status === "skipped" && "text-muted-foreground line-through",
                    )}
                  >
                    <Icon className="size-3.5" aria-hidden="true" />
                    {a.name}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-56 p-2">
                  <p className="text-muted-foreground px-2 pb-1 text-xs">{statusLabel}</p>
                  <div className="grid gap-1">
                    {a.status !== "covered" && a.status !== "skipped" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="justify-start"
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
                      className="justify-start"
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
