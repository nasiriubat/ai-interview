"use client";

import {
  ActivityIcon,
  BuildingIcon,
  LogOutIcon,
  ClipboardListIcon,
  CoinsIcon,
  FileTextIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  MegaphoneIcon,
  MenuIcon,
  MessageSquareTextIcon,
  RouteIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { DirtyGuardProvider } from "@/components/common/DirtyGuard";
import { LanguageSwitch } from "@/components/common/LanguageSwitch";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { Me } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: typeof MenuIcon;
  exact?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/*
 * Functions, not module constants: a label read at module load takes the locale of whoever imported
 * the module first (the server's default), and every later request would render the sidebar in it.
 */
function mainNav(): NavGroup[] {
  return [
    {
      label: t.admin.nav.groups.research,
      items: [
        { href: "/admin", label: t.admin.nav.dashboard, icon: LayoutDashboardIcon, exact: true },
        { href: "/admin/campaigns", label: t.admin.nav.campaigns, icon: MegaphoneIcon },
        { href: "/admin/requirements", label: t.admin.nav.requirements, icon: ClipboardListIcon },
        { href: "/admin/templates", label: t.admin.nav.templates, icon: FileTextIcon },
      ],
    },
    {
      label: t.admin.nav.groups.configuration,
      items: [
        { href: "/admin/settings", label: t.admin.nav.settings, icon: SettingsIcon },
        { href: "/admin/providers", label: t.admin.nav.providers, icon: ServerIcon },
        { href: "/admin/routes", label: t.admin.nav.routes, icon: RouteIcon },
        { href: "/admin/budgets", label: t.admin.nav.budgets, icon: CoinsIcon },
        { href: "/admin/prompts", label: t.admin.nav.prompts, icon: MessageSquareTextIcon },
      ],
    },
    {
      label: t.admin.nav.groups.organization,
      items: [
        { href: "/admin/users", label: t.admin.nav.users, icon: UsersIcon },
        { href: "/admin/audit", label: t.admin.nav.audit, icon: ScrollTextIcon },
      ],
    },
  ];
}

function operatorNav(): NavItem[] {
  return [
    { href: "/admin/operator", label: t.admin.nav.tenants, icon: BuildingIcon, exact: true },
    { href: "/admin/operator/providers", label: t.admin.nav.platformProviders, icon: ServerIcon },
    { href: "/admin/operator/routes", label: t.admin.nav.platformRoutes, icon: RouteIcon },
    { href: "/admin/operator/stats", label: t.admin.nav.platformStats, icon: ActivityIcon },
    { href: "/admin/operator/jobs", label: t.admin.nav.platformJobs, icon: ListChecksIcon },
  ];
}

export function AdminShell({
  me,
  signOutAction,
  children,
}: {
  me: Me | null;
  signOutAction: () => Promise<void>;
  children: React.ReactNode;
}): React.JSX.Element {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const isOperator = me?.user.role === "platform_operator";
  const isActive = (item: NavItem): boolean =>
    item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);

  const close = (): void => {
    setOpen(false);
  };
  const main = mainNav();
  const groups = isOperator ? [...main, { label: t.admin.nav.operator, items: operatorNav() }] : main;
  const nav = (
    <nav aria-label={t.admin.nav.menu} className="grid gap-5 text-sm">
      {groups.map((group) => (
        <div key={group.label} className="grid gap-0.5">
          <p className="text-muted-foreground mb-1 px-2.5 text-[11px] font-semibold tracking-wider uppercase">
            {group.label}
          </p>
          {group.items.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item)} onNavigate={close} />
          ))}
        </div>
      ))}
    </nav>
  );

  return (
    <DirtyGuardProvider>
      <div className="flex min-h-dvh">
        <aside className="bg-sidebar sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r px-3 py-4 md:flex print:hidden">
          <Brand />
          <div className="-mx-1 flex-1 overflow-y-auto px-1 pt-5">{nav}</div>
          <UserBox me={me} signOutAction={signOutAction} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="bg-card/90 sticky top-0 z-20 flex items-center justify-between border-b px-4 py-2 backdrop-blur md:hidden print:hidden">
            <Brand />
            <div className="flex items-center gap-2">
              <LanguageSwitch />
              <Button
                variant="ghost"
                size="icon"
                aria-label={t.admin.nav.menu}
                aria-expanded={open}
                aria-controls="mobile-nav"
                onClick={() => {
                  setOpen((v) => !v);
                }}
              >
                {open ? <XIcon /> : <MenuIcon />}
              </Button>
            </div>
          </header>
          {open ? (
            <div id="mobile-nav" className="bg-card border-b p-4 shadow-sm md:hidden print:hidden">
              {nav}
              <div className="mt-4">
                <UserBox me={me} signOutAction={signOutAction} />
              </div>
            </div>
          ) : null}
          <main
            id="main"
            className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-10 md:py-8 print:max-w-none print:p-0"
          >
            {children}
          </main>
        </div>
      </div>
    </DirtyGuardProvider>
  );
}

function Brand(): React.JSX.Element {
  return (
    <Link href="/admin" className="flex items-center gap-2.5 px-2.5 text-[15px] font-semibold tracking-tight">
      <span
        aria-hidden="true"
        className="grid size-7 place-items-center rounded-md bg-brand-gradient text-xs font-bold text-white shadow-sm"
      >
        D
      </span>
      <span className="text-foreground">{t.app.name}</span>
    </Link>
  );
}

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: () => void;
}): React.JSX.Element {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "text-sidebar-foreground hover:bg-muted hover:text-foreground flex items-center gap-2.5 rounded-md px-2.5 py-1.5 font-medium transition-colors",
        active &&
          "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
    >
      <Icon className={cn("size-4", active ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
      {item.label}
    </Link>
  );
}

function initials(email: string): string {
  const name = email.split("@")[0] ?? "";
  const parts = name.split(/[._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : name.slice(0, 2);
  return letters.toUpperCase();
}

function UserBox({
  me,
  signOutAction,
}: {
  me: Me | null;
  signOutAction: () => Promise<void>;
}): React.JSX.Element {
  return (
    <div className="grid gap-3 border-t pt-3 text-xs">
      {me ? (
        <div className="flex items-center gap-2.5 px-1.5">
          <span
            aria-hidden="true"
            className="bg-accent text-accent-foreground grid size-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold"
          >
            {initials(me.user.email)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-foreground truncate text-[13px] font-medium" title={me.user.email}>
              <span className="sr-only">{t.admin.nav.signedInAs(me.user.email)}</span>
              <span aria-hidden="true">{me.user.email}</span>
            </p>
            <p className="text-muted-foreground truncate">
              {t.admin.nav.role[me.user.role]}
              {me.company ? ` · ${me.company.name}` : ""}
            </p>
          </div>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2 px-1.5">
        <div className="hidden md:block">
          <LanguageSwitch />
        </div>
        <form action={signOutAction}>
          <Button type="submit" variant="ghost" size="sm">
            <LogOutIcon aria-hidden="true" />
            {t.app.signOut}
          </Button>
        </form>
      </div>
    </div>
  );
}
