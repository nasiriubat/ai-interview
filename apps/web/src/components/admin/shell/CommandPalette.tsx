"use client";

import { CornerDownLeftIcon, SearchIcon } from "lucide-react";
import * as React from "react";
import { navFor, paletteActions, matchesQuery, type NavItem } from "@/components/admin/shell/nav";
import { useDirtyGuard } from "@/components/common/DirtyGuard";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import type { Role } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

interface Entry {
  id: string;
  label: string;
  href: string;
  group: "pages" | "actions";
  icon: NavItem["icon"];
}

export function buildEntries(role: Role | undefined): Entry[] {
  const pages = navFor(role).flatMap((g) => g.items);
  return [
    ...pages.map((p) => ({
      id: p.href,
      label: p.label,
      href: p.href,
      group: "pages" as const,
      icon: p.icon,
    })),
    ...paletteActions(role).map((a) => ({
      id: a.id,
      label: a.label,
      href: a.href,
      group: "actions" as const,
      icon: a.icon,
    })),
  ];
}

/**
 * The quick search of the shell (Ctrl or Cmd + K): jump to any page the person's role can see, or
 * start the common actions. A combobox over a listbox, so a screen reader hears the count and the
 * highlighted option; Enter goes, Escape closes. Navigation goes through the dirty-form guard.
 */
export function CommandPalette({
  open,
  onOpenChange,
  role,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: Role | undefined;
}): React.JSX.Element {
  const p = t.kit.shell.palette;
  const { navigate } = useDirtyGuard();
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listId = React.useId();
  const entries = React.useMemo(() => buildEntries(role), [role]);
  const results = React.useMemo(() => entries.filter((e) => matchesQuery(e.label, query)), [entries, query]);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);
  React.useEffect(() => {
    setActive(0);
  }, [query]);

  const go = (entry: Entry | undefined): void => {
    if (!entry) return;
    onOpenChange(false);
    navigate(entry.href);
  };

  const optionId = (i: number): string => `${listId}-opt-${String(i)}`;
  const groups: ("pages" | "actions")[] = ["pages", "actions"];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={t.app.close}
        className="top-[18%] max-w-xl translate-y-0 gap-0 p-0 sm:max-w-xl"
        aria-describedby={`${listId}-desc`}
      >
        <DialogTitle className="sr-only">{p.title}</DialogTitle>
        <DialogDescription id={`${listId}-desc`} className="sr-only">
          {p.description}
        </DialogDescription>
        <div className="flex items-center gap-2 border-b px-4">
          <SearchIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
          <input
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results.length > 0 ? optionId(active) : undefined}
            aria-label={p.title}
            value={query}
            placeholder={p.placeholder}
            autoComplete="off"
            spellCheck={false}
            className="placeholder:text-muted-foreground h-12 min-w-0 flex-1 bg-transparent text-base outline-hidden md:text-sm"
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
              } else if (e.key === "Enter") {
                e.preventDefault();
                go(results[active]);
              }
            }}
          />
        </div>
        <div role="status" className="sr-only">
          {query ? p.results(results.length) : ""}
        </div>
        <div id={listId} role="listbox" aria-label={p.title} className="max-h-80 overflow-y-auto p-2">
          {results.length === 0 ? (
            <p className="text-muted-foreground px-3 py-8 text-center text-sm">{p.none}</p>
          ) : (
            groups.map((group) => {
              const items = results.filter((r) => r.group === group);
              if (items.length === 0) return null;
              return (
                <div key={group} role="group" aria-label={group === "pages" ? p.groupPages : p.groupActions}>
                  <p
                    aria-hidden="true"
                    className="text-muted-foreground px-3 pt-2 pb-1 text-xs font-semibold tracking-wide uppercase"
                  >
                    {group === "pages" ? p.groupPages : p.groupActions}
                  </p>
                  {items.map((entry) => {
                    const index = results.indexOf(entry);
                    const Icon = entry.icon;
                    const selected = index === active;
                    return (
                      <div
                        key={entry.id}
                        id={optionId(index)}
                        role="option"
                        aria-selected={selected}
                        onMouseMove={() => {
                          setActive(index);
                        }}
                        onClick={() => {
                          go(entry);
                        }}
                        className={cn(
                          "flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm",
                          selected ? "bg-accent text-accent-foreground" : "text-foreground",
                        )}
                      >
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                        {selected ? (
                          <CornerDownLeftIcon className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
