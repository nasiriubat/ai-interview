"use client";

import Link from "next/link";
import * as React from "react";
import { isActive, type NavGroup, type NavItem } from "@/components/admin/shell/nav";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

export function Brand({ collapsed = false }: { collapsed?: boolean }): React.JSX.Element {
  return (
    <Link
      href="/admin"
      aria-label={t.app.name}
      className={cn(
        "flex h-10 items-center gap-2.5 rounded-md text-[15px] font-semibold tracking-tight",
        collapsed ? "justify-center" : "px-2.5",
      )}
    >
      <span
        aria-hidden="true"
        className="bg-brand-gradient text-brand-text grid size-8 shrink-0 place-items-center rounded-lg text-sm font-bold shadow-sm"
      >
        D
      </span>
      {collapsed ? null : <span className="text-foreground truncate">{t.app.name}</span>}
    </Link>
  );
}

function NavLink({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
}): React.JSX.Element {
  const Icon = item.icon;
  const link = (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? item.label : undefined}
      {...(onNavigate ? { onClick: onNavigate } : {})}
      className={cn(
        "text-sidebar-foreground hover:bg-muted hover:text-foreground flex h-9 items-center gap-2.5 rounded-md text-sm font-medium transition-colors",
        collapsed ? "justify-center" : "px-2.5",
        active &&
          "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
    >
      <Icon
        className={cn("size-[18px] shrink-0", active ? "text-primary" : "text-muted-foreground")}
        aria-hidden="true"
      />
      {collapsed ? null : <span className="truncate">{item.label}</span>}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        {item.label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The navigation list, used by the desktop sidebar (expanded or icon-only) and the mobile drawer.
 * Collapsed: icons only, each with a tooltip on hover and focus and its name as the accessible name.
 */
export function SideNav({
  groups,
  pathname,
  collapsed = false,
  onNavigate,
}: {
  groups: NavGroup[];
  pathname: string;
  collapsed?: boolean;
  onNavigate?: () => void;
}): React.JSX.Element {
  return (
    <nav aria-label={t.kit.shell.mainNav} className="grid gap-4">
      {groups.map((group, i) => (
        <div key={group.label} className="grid gap-0.5">
          {collapsed ? (
            i > 0 ? (
              <hr className="border-border mx-2 mb-1.5" />
            ) : null
          ) : (
            <p className="text-muted-foreground mb-1 px-2.5 text-xs font-semibold tracking-wider uppercase">
              {group.label}
            </p>
          )}
          {group.items.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={isActive(item, pathname)}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}
