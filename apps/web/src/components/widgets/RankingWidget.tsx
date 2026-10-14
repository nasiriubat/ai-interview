"use client";

import type { Widget, WidgetResponse } from "@aidp/shared";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import * as React from "react";
import { OptionDetail } from "./OptionDetail";
import { Button } from "@/components/ui/button";
import { Inset } from "@/components/ui/inset";
import { t } from "@/i18n";

/** Ranking with up/down buttons (keyboard and screen-reader friendly; drag is a later enhancement). */
export function RankingWidget({
  widget,
  disabled,
  onSubmit,
}: {
  widget: Extract<Widget, { type: "ranking" }>;
  disabled?: boolean | undefined;
  onSubmit: (response: WidgetResponse) => void;
}): React.JSX.Element {
  const id = React.useId();
  const [order, setOrder] = React.useState<string[]>(() => widget.options.map((o) => o.key));
  const [announcement, setAnnouncement] = React.useState("");
  const byKey = new Map(widget.options.map((o) => [o.key, o]));

  const move = (index: number, delta: -1 | 1): void => {
    setOrder((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      if (item === undefined) return prev;
      next.splice(target, 0, item);
      const label = byKey.get(item)?.label ?? item;
      setAnnouncement(`${label}: ${t.participant.session.widgetRankPosition(target + 1, prev.length)}`);
      return next;
    });
  };

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) return;
        onSubmit({ type: "ranking", keys: order });
      }}
    >
      <p className="text-muted-foreground text-xs">{t.participant.session.widgetRankingHint}</p>
      <ol className="grid gap-2" aria-label={t.participant.session.widgetAnswer}>
        {order.map((key, i) => {
          const o = byKey.get(key);
          if (!o) return null;
          return (
            <Inset as="li" key={key} className="bg-muted/60 flex items-start gap-2 p-2 pl-3">
              <span className="bg-muted mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1 py-1">
                <span className="text-sm leading-snug">{o.label}</span>
                <OptionDetail id={`${id}-${key}-detail`} label={o.label} detail={o.detail} />
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={(disabled ?? false) || i === 0}
                  aria-label={`${t.app.moveUp}: ${o.label}`}
                  onClick={() => {
                    move(i, -1);
                  }}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={(disabled ?? false) || i === order.length - 1}
                  aria-label={`${t.app.moveDown}: ${o.label}`}
                  onClick={() => {
                    move(i, 1);
                  }}
                >
                  <ArrowDownIcon />
                </Button>
              </div>
            </Inset>
          );
        })}
      </ol>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <Button type="submit" disabled={disabled} className="w-full sm:w-auto">
        {t.participant.session.widgetSubmit}
      </Button>
      <p className="text-muted-foreground text-xs">{t.participant.session.widgetIgnore}</p>
    </form>
  );
}
