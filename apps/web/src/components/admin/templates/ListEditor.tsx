"use client";

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/** Generic ordered list editor with add, remove and up/down reorder. */
export function ListEditor<T>({
  items,
  onChange,
  renderItem,
  create,
  addLabel,
  itemLabel,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  renderItem: (item: T, update: (patch: Partial<T>) => void, index: number) => React.ReactNode;
  create: () => T;
  addLabel: string;
  itemLabel: (item: T, index: number) => string;
}): React.JSX.Element {
  const move = (i: number, d: -1 | 1): void => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    const a = next[i];
    const b = next[j];
    if (a === undefined || b === undefined) return;
    next[i] = b;
    next[j] = a;
    onChange(next);
  };
  return (
    <div className="grid gap-3">
      <ol className="grid gap-3">
        {items.map((item, i) => (
          <li key={i} className="bg-muted/30 grid gap-3 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">
                {i + 1}. {itemLabel(item, i)}
              </span>
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={i === 0}
                  aria-label={`${t.app.moveUp}: ${itemLabel(item, i)}`}
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
                  disabled={i === items.length - 1}
                  aria-label={`${t.app.moveDown}: ${itemLabel(item, i)}`}
                  onClick={() => {
                    move(i, 1);
                  }}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${t.app.remove}: ${itemLabel(item, i)}`}
                  onClick={() => {
                    onChange(items.filter((_, k) => k !== i));
                  }}
                >
                  <Trash2Icon />
                </Button>
              </div>
            </div>
            {renderItem(
              item,
              (patch) => {
                onChange(items.map((it, k) => (k === i ? { ...it, ...patch } : it)));
              },
              i,
            )}
          </li>
        ))}
      </ol>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            onChange([...items, create()]);
          }}
        >
          <PlusIcon /> {addLabel}
        </Button>
      </div>
    </div>
  );
}
