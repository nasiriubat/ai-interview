"use client";

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import * as React from "react";
import { IconButton } from "@/components/admin/IconButton";
import { Button } from "@/components/ui/button";
import { Inset } from "@/components/ui/inset";
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
          <Inset as="li" key={i} className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">
                {i + 1}. {itemLabel(item, i)}
              </span>
              <div className="flex gap-1">
                <IconButton
                  disabled={i === 0}
                  label={`${t.app.moveUp}: ${itemLabel(item, i)}`}
                  icon={<ArrowUpIcon />}
                  onClick={() => {
                    move(i, -1);
                  }}
                />
                <IconButton
                  disabled={i === items.length - 1}
                  label={`${t.app.moveDown}: ${itemLabel(item, i)}`}
                  icon={<ArrowDownIcon />}
                  onClick={() => {
                    move(i, 1);
                  }}
                />
                <IconButton
                  label={`${t.app.remove}: ${itemLabel(item, i)}`}
                  icon={<Trash2Icon />}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    onChange(items.filter((_, k) => k !== i));
                  }}
                />
              </div>
            </div>
            {renderItem(
              item,
              (patch) => {
                onChange(items.map((it, k) => (k === i ? { ...it, ...patch } : it)));
              },
              i,
            )}
          </Inset>
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
