"use client";

import { PanelLeftOpenIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { IconButton } from "@/components/admin/IconButton";
import { isActive, type NavGroup, type NavItem } from "@/components/admin/shell/nav";
import { ProductMark, useBranding } from "@/components/common/Branding";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The top of the sidebar (D-430): the platform's logo, or its name in type, linking to the
 * overview. There is no letter tile. Icon-only, a logo shrinks to the rail's width; without one
 * there is nothing to show but a mark nobody chose, so the slot becomes the expand button.
 */
export function Brand({
  collapsed = false,
  onExpand,
}: {
  collapsed?: boolean;
  onExpand?: (() => void) | undefined;
}): React.JSX.Element {
  const branding = useBranding();
  if (collapsed && !branding.logoUrl && onExpand) {
    return (
      <div className="flex h-10 items-center justify-center" data-sidebar-toggle="">
        <IconButton label={t.kit.shell.expand} icon={<PanelLeftOpenIcon />} size="icon" onClick={onExpand} />
      </div>
    );
  }
  return (
    <Link
      href="/admin"
      className={cn("flex h-10 min-w-0 items-center rounded-md", collapsed ? "justify-center" : "px-2.5")}
    >
      {collapsed && branding.logoUrl ? (
        <img
          src={branding.logoUrl}
          alt={branding.productName}
          className="block max-h-8 w-auto max-w-10 object-contain"
        />
      ) : (
        <ProductMark branding={branding} />
      )}
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
