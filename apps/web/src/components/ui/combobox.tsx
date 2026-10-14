"use client";

import { CheckIcon, ChevronsUpDownIcon, Loader2Icon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface ComboboxOption {
  value: string;
  label: string;
  /** A second line under the label: an id, a price, a description. */
  detail?: string | undefined;
}

export interface ComboboxLabels {
  /** Shown on the trigger when nothing is selected. */
  placeholder: string;
  /** Placeholder of the filter input. */
  search: string;
  /** Shown when the filter matches nothing. */
  empty: string;
  /** Shown while `loading` is true. */
  loading?: string | undefined;
  /** Label of the free-text row, e.g. `Use “gpt-5-mini”`. Required with `allowCustom`. */
  useCustom?: ((value: string) => string) | undefined;
}

export interface ComboboxProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly ComboboxOption[];
  labels: ComboboxLabels;
  /** Accepts a value the list does not offer (a model id the provider did not publish). */
  allowCustom?: boolean | undefined;
  loading?: boolean | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  /** When the trigger has no visible `<label htmlFor>`. */
  "aria-label"?: string | undefined;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: boolean | undefined;
  size?: "default" | "sm" | undefined;
}

function matches(option: ComboboxOption, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    option.label.toLowerCase().includes(q) ||
    option.value.toLowerCase().includes(q) ||
    (option.detail ?? "").toLowerCase().includes(q)
  );
}

/**
 * A searchable dropdown built on the popover primitive: a trigger that always shows the
 * current value, a filter input, and a listbox driven from the keyboard (up, down, home,
 * end, enter, escape). With `allowCustom` the typed text itself can be chosen, so a model
 * id the provider did not list is still reachable.
 */
export function Combobox({
  id,
  value,
  onChange,
  options,
  labels,
  allowCustom,
  loading,
  disabled,
  className,
  size = "default",
  ...aria
}: ComboboxProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listId = `${id}-listbox`;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  const filtered = React.useMemo(() => options.filter((o) => matches(o, query)), [options, query]);
  const custom = allowCustom && query.trim() && !options.some((o) => o.value === query.trim());
  const customValue = query.trim();
  const rows: ComboboxOption[] = custom
    ? [...filtered, { value: customValue, label: labels.useCustom?.(customValue) ?? customValue }]
    : [...filtered];

  const selected = options.find((o) => o.value === value);
  const triggerLabel = selected?.label ?? (value || labels.placeholder);

  React.useEffect(() => {
    setActive(0);
  }, [query, open]);

  const close = (): void => {
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  };

  const choose = (v: string): void => {
    onChange(v);
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (rows.length === 0 && e.key !== "Escape") return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + rows.length) % rows.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(rows.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) choose(row.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          ref={triggerRef}
          type="button"
          variant="outline"
          size={size}
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
          aria-label={aria["aria-label"]}
          aria-describedby={aria["aria-describedby"]}
          aria-invalid={aria["aria-invalid"]}
          className={cn(
            "w-full min-w-0 justify-between font-normal",
            !selected && !value && "text-muted-foreground",
            className,
          )}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDownIcon className="opacity-60" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(20rem,calc(100vw-2rem))] p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <div className="border-b p-2">
          <Input
            ref={inputRef}
            role="combobox"
            aria-expanded
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={rows[active] ? `${listId}-${String(active)}` : undefined}
            placeholder={labels.search}
            value={query}
            className="h-9"
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {loading ? (
          <p className="text-muted-foreground flex items-center gap-2 p-3 text-sm" role="status">
            <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {labels.loading ?? ""}
          </p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground p-3 text-sm" role="status">
            {labels.empty}
          </p>
        ) : (
          <ul id={listId} role="listbox" aria-label={labels.search} className="max-h-64 overflow-y-auto p-1">
            {rows.map((o, i) => (
              <li
                key={`${o.value}-${String(i)}`}
                id={`${listId}-${String(i)}`}
                role="option"
                aria-selected={o.value === value}
                data-active={i === active ? "" : undefined}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-sm",
                  i === active && "bg-accent text-accent-foreground",
                )}
                onMouseEnter={() => {
                  setActive(i);
                }}
                onClick={() => {
                  choose(o.value);
                }}
              >
                <CheckIcon
                  className={cn("mt-0.5 size-4 shrink-0", o.value === value ? "opacity-100" : "opacity-0")}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{o.label}</span>
                  {o.detail ? (
                    <span className="text-muted-foreground block truncate text-xs">{o.detail}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
