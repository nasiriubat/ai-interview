"use client";

import { XIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { Dialog as DrawerPrimitive } from "radix-ui";
import * as React from "react";
import { CommandPalette } from "@/components/admin/shell/CommandPalette";
import { CrumbProvider } from "@/components/admin/shell/crumbs";
import { navFor, type NavCounts } from "@/components/admin/shell/nav";
import { Brand, SideNav } from "@/components/admin/shell/Sidebar";
import { sidebarCookie } from "@/components/admin/shell/sidebar-state";
import { TopBar } from "@/components/admin/shell/TopBar";
import { useBranding } from "@/components/common/Branding";
import { DirtyGuardProvider } from "@/components/common/DirtyGuard";
import { t } from "@/i18n";
import type { Me } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

/**
 * The frame of every admin page (D-340): a rounded sidebar panel and, a small gap to its right, a
 * rounded content panel that holds the sticky top bar and the page. The content panel is fluid:
 * it takes the width the screen has, and pages decide where a reading column is wanted. Below
 * `md` the sidebar becomes a drawer opened from the top bar and the content panel runs edge to
 * edge. The sidebar collapses to icons; the choice is kept in a cookie.
 */
export function AdminShell({
  me,
  initialCollapsed = false,
  counts,
  children,
}: {
  me: Me | null;
  initialCollapsed?: boolean;
  /** Numbers the sidebar shows beside items: open errors for the operator (D-477). */
  counts?: NavCounts | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(initialCollapsed);
  const [drawer, setDrawer] = React.useState(false);
  const [search, setSearch] = React.useState(false);
  const groups = navFor(me?.user.role, counts);
  const branding = useBranding();

  // A route change closes the drawer: the link that was tapped is the reason it was open.
  React.useEffect(() => {
    setDrawer(false);
  }, [pathname]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const toggle = (): void => {
    setCollapsed((c) => {
      document.cookie = sidebarCookie(!c);
      return !c;
    });
  };

  // Without a logo the collapsed sidebar holds the expand button and the top bar's toggle goes
  // away (D-430), so the button that was just pressed may no longer exist. Focus follows the
  // toggle to wherever it now is, instead of dropping to the page.
  const firstRender = React.useRef(true);
  React.useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (document.activeElement && document.activeElement !== document.body) return;
    document.querySelector<HTMLElement>("[data-sidebar-toggle] button")?.focus();
  }, [collapsed]);

  return (
    <DirtyGuardProvider>
      <CrumbProvider>
        <div className="flex min-h-dvh gap-2 lg:p-2 print:block print:p-0">
          <aside
            aria-label={t.kit.shell.sidebar}
            data-collapsed={collapsed}
            className={cn(
              "bg-sidebar shadow-card sticky top-2 hidden h-[calc(100dvh-1rem)] shrink-0 flex-col rounded-xl px-2 py-3 transition-[width] duration-200 motion-reduce:transition-none lg:flex print:hidden",
              collapsed ? "w-16" : "w-60",
            )}
          >
            <Brand collapsed={collapsed} onExpand={toggle} />
            <div className="mt-5 min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
              <SideNav groups={groups} pathname={pathname} collapsed={collapsed} />
            </div>
            {me?.company ? (
              <div
                className={cn(
                  "bg-muted/60 mt-3 flex items-center gap-2 rounded-lg",
                  collapsed ? "justify-center p-1.5" : "px-3 py-2",
                )}
                title={me.company.name}
              >
                <span
                  aria-hidden="true"
                  className="bg-card text-foreground grid size-7 shrink-0 place-items-center rounded-md text-xs font-semibold shadow-sm"
                >
                  {me.company.name.slice(0, 1).toUpperCase()}
                </span>
                {collapsed ? (
                  <span className="sr-only">{me.company.name}</span>
                ) : (
                  <span className="min-w-0">
                    <span className="text-foreground block truncate text-[13px] leading-tight font-medium">
                      {me.company.name}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs leading-tight">
                      {t.admin.nav.role[me.user.role]}
                    </span>
                  </span>
                )}
              </div>
            ) : null}
          </aside>

          <div className="bg-card shadow-card flex min-w-0 flex-1 flex-col lg:rounded-xl print:shadow-none">
            <TopBar
              me={me}
              collapsed={collapsed}
              toggleInSidebar={collapsed && !branding.logoUrl}
              onToggleSidebar={toggle}
              onOpenDrawer={() => {
                setDrawer(true);
              }}
              onOpenSearch={() => {
                setSearch(true);
              }}
            />
            <main
              id="main"
              tabIndex={-1}
              className="mx-auto w-full max-w-[120rem] flex-1 px-4 py-5 outline-hidden sm:px-6 md:py-6 lg:px-8 print:max-w-none print:p-0"
            >
              {children}
            </main>
          </div>
        </div>

        <DrawerPrimitive.Root open={drawer} onOpenChange={setDrawer}>
          <DrawerPrimitive.Portal>
            <DrawerPrimitive.Overlay className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 bg-overlay fixed inset-0 z-50 backdrop-blur-[2px] lg:hidden" />
            <DrawerPrimitive.Content
              aria-describedby={undefined}
              className="bg-sidebar data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left shadow-raised fixed inset-y-0 left-0 z-50 flex w-[min(20rem,calc(100vw-3rem))] flex-col px-3 py-3 duration-200 lg:hidden"
            >
              <DrawerPrimitive.Title className="sr-only">{t.kit.shell.mainNav}</DrawerPrimitive.Title>
              <div className="flex items-center justify-between">
                <Brand />
                <DrawerPrimitive.Close
                  aria-label={t.kit.shell.closeMenu}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground grid size-9 place-items-center rounded-md"
                >
                  <XIcon className="size-5" aria-hidden="true" />
                </DrawerPrimitive.Close>
              </div>
              <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
                <SideNav
                  groups={groups}
                  pathname={pathname}
                  onNavigate={() => {
                    setDrawer(false);
                  }}
                />
              </div>
              {me?.company ? (
                <p className="text-muted-foreground mt-3 truncate border-t pt-3 text-xs">
                  {me.company.name} · {t.admin.nav.role[me.user.role]}
                </p>
              ) : null}
            </DrawerPrimitive.Content>
          </DrawerPrimitive.Portal>
        </DrawerPrimitive.Root>

        <CommandPalette open={search} onOpenChange={setSearch} role={me?.user.role} />
      </CrumbProvider>
    </DirtyGuardProvider>
  );
}
