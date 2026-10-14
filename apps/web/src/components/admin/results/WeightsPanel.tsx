"use client";

import { FACTOR_KEYS, type Weights } from "@aidp/shared";
import { CheckIcon, Loader2Icon } from "lucide-react";
import * as React from "react";
import { ChoiceTile } from "@/components/ui/choice-tile";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { SaveState } from "@/hooks/useDebouncedSave";
import { t } from "@/i18n";
import { WEIGHT_PRESET_KEYS, type WeightsPreset } from "@/lib/analysis/rank";

/**
 * How much each factor counts toward the score, in a side sheet (D-372). The list re-ranks as a
 * slider moves and the choice is saved for the campaign after a short pause, so the sheet has no
 * Save button and says "Saved" instead.
 */
export function WeightsPanel({
  open,
  onOpenChange,
  preset,
  weights,
  onPresetChange,
  onWeightChange,
  saveState,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset: WeightsPreset;
  /** The weights in force (the preset's, or the custom vector). */
  weights: Weights;
  onPresetChange: (preset: WeightsPreset) => void;
  onWeightChange: (key: (typeof FACTOR_KEYS)[number], value: number) => void;
  saveState: SaveState;
}): React.JSX.Element {
  const s = t.admin.results.weights;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent closeLabel={t.app.close} className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{s.title}</SheetTitle>
          <SheetDescription>{s.body}</SheetDescription>
        </SheetHeader>
        <div className="grid gap-5">
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{s.preset}</legend>
            <RadioGroup
              value={preset}
              onValueChange={(v) => {
                onPresetChange(v as WeightsPreset);
              }}
              className="grid grid-cols-2 gap-2"
            >
              {WEIGHT_PRESET_KEYS.map((p) => (
                <ChoiceTile key={p} compact className="items-center gap-2 px-3 py-2 text-sm">
                  <RadioGroupItem value={p} />
                  {s.presets[p]}
                </ChoiceTile>
              ))}
            </RadioGroup>
          </fieldset>
          <div className="grid gap-3.5">
            {FACTOR_KEYS.map((k) => {
              const id = `weight-${k}`;
              return (
                <div key={k} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
                  <Label htmlFor={id} className="text-[13px]">
                    {t.admin.results.factors[k]}
                  </Label>
                  <span className="text-sm font-medium tabular-nums">{weights[k].toFixed(1)}</span>
                  <input
                    id={id}
                    type="range"
                    min={0}
                    max={5}
                    step={0.5}
                    value={weights[k]}
                    aria-label={s.weightOf(t.admin.results.factors[k])}
                    aria-valuetext={weights[k].toFixed(1)}
                    onChange={(e) => {
                      onWeightChange(k, Number(e.target.value));
                    }}
                    className="accent-primary col-span-2 h-2 w-full cursor-pointer"
                  />
                </div>
              );
            })}
          </div>
          <p
            className="text-muted-foreground flex min-h-5 items-center gap-1.5 text-xs"
            role="status"
            aria-live="polite"
          >
            {saveState.kind === "saving" ? (
              <>
                <Loader2Icon className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                {t.app.saving}
              </>
            ) : saveState.kind === "saved" ? (
              <>
                <CheckIcon className="size-3" aria-hidden="true" />
                {s.saved}
              </>
            ) : saveState.kind === "error" ? (
              <span className="text-destructive">{saveState.text}</span>
            ) : null}
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
