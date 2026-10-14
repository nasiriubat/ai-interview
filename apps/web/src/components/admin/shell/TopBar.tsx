"use client";

import { MenuIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, SearchIcon } from "lucide-react";
import * as React from "react";
import { Breadcrumbs } from "@/components/admin/Breadcrumbs";
import { IconButton } from "@/components/admin/IconButton";
import { UserMenu } from "@/components/admin/shell/UserMenu";
import { t } from "@/i18n";
import type { Me } from "@/lib/api/schemas";

/**
 * The bar across the top of the content panel (D-340): menu or collapse toggle, the breadcrumb
 * trail, quick search, and the person's menu. It sticks to the top of the viewport while the page
 * scrolls beneath it.
 */
export function TopBar({
  me,
  collapsed,
  toggleInSidebar = false,
  onToggleSidebar,
  onOpenDrawer,
  onOpenSearch,
}: {
  me: Me | null;
  collapsed: boolean;
  /** The collapsed sidebar shows the expand button itself (it has no logo to show), so this bar does not repeat it. */
  toggleInSidebar?: boolean;
  onToggleSidebar: () => void;
  onOpenDrawer: () => void;
  onOpenSearch: () => void;
}): React.JSX.Element {
  const k = t.kit.shell;
  const [mac, setMac] = React.useState(false);
  React.useEffect(() => {
    setMac(/mac|iphone|ipad/i.test(navigator.userAgent));
  }, []);
  return (
    <header
      aria-label={k.topbar}
      className="bg-card/95 supports-[backdrop-filter]:bg-card/80 sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b px-3 backdrop-blur lg:top-2 lg:rounded-t-xl lg:px-4 print:hidden"
    >
      <div className="lg:hidden">
        <IconButton label={k.openMenu} icon={<MenuIcon />} onClick={onOpenDrawer} />
      </div>
      {toggleInSidebar ? null : (
        <div className="hidden lg:block" data-sidebar-toggle="">
          <IconButton
            label={collapsed ? k.expand : k.collapse}
            icon={collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
            onClick={onToggleSidebar}
          />
        </div>
      )}
      <Breadcrumbs className="flex-1" />
      <button
        type="button"
        onClick={onOpenSearch}
        aria-label={k.searchHint}
        aria-keyshortcuts="Control+K Meta+K"
        className="text-muted-foreground hover:text-foreground bg-muted/60 hover:bg-muted hidden h-9 w-56 items-center gap-2 rounded-md px-3 text-sm transition-colors md:flex xl:w-72"
      >
        <SearchIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 truncate text-left">{k.searchButton}</span>
        <kbd className="text-muted-foreground bg-card shadow-button rounded px-1.5 py-0.5 font-sans text-xs">
          {mac ? "⌘" : "Ctrl"} K
        </kbd>
      </button>
      <div className="md:hidden">
        <IconButton label={k.searchHint} icon={<SearchIcon />} onClick={onOpenSearch} />
      </div>
      <UserMenu me={me} />
    </header>
  );
}
