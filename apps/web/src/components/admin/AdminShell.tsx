"use client";

import {
  ActivityIcon,
  BuildingIcon,
  ClipboardListIcon,
  CoinsIcon,
  FileTextIcon,
  LayoutDashboardIcon,
  MegaphoneIcon,
  MenuIcon,
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
import { LanguageSwitch } from "@/components/common/LanguageSwitch";
import { Badge } from "@/components/ui/badge";
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

const MAIN: NavItem[] = [
  { href: "/admin", label: t.admin.nav.dashboard, icon: LayoutDashboardIcon, exact: true },
  { href: "/admin/templates", label: t.admin.nav.templates, icon: FileTextIcon },
  { href: "/admin/campaigns", label: t.admin.nav.campaigns, icon: MegaphoneIcon },
  { href: "/admin/requirements", label: t.admin.nav.requirements, icon: ClipboardListIcon },
  { href: "/admin/settings", label: t.admin.nav.settings, icon: SettingsIcon },
  { href: "/admin/providers", label: t.admin.nav.providers, icon: ServerIcon },
  { href: "/admin/routes", label: t.admin.nav.routes, icon: RouteIcon },
  { href: "/admin/budgets", label: t.admin.nav.budgets, icon: CoinsIcon },
  { href: "/admin/users", label: t.admin.nav.users, icon: UsersIcon },
  { href: "/admin/audit", label: t.admin.nav.audit, icon: ScrollTextIcon },
];

const OPERATOR: NavItem[] = [
  { href: "/admin/operator", label: t.admin.nav.tenants, icon: BuildingIcon, exact: true },
  { href: "/admin/operator/providers", label: t.admin.nav.platformProviders, icon: ServerIcon },
  { href: "/admin/operator/routes", label: t.admin.nav.platformRoutes, icon: RouteIcon },
  { href: "/admin/operator/stats", label: t.admin.nav.platformStats, icon: ActivityIcon },
];

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

  const nav = (
    <nav aria-label={t.admin.nav.menu} className="grid gap-1 text-sm">
      {MAIN.map((item) => (
        <NavLink
          key={item.href}
          item={item}
          active={isActive(item)}
          onNavigate={() => {
            setOpen(false);
          }}
        />
      ))}
      {isOperator ? (
        <>
          <p className="text-muted-foreground mt-4 mb-1 px-2 text-xs font-medium tracking-wide uppercase">
            {t.admin.nav.operator}
          </p>
          {OPERATOR.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={isActive(item)}
              onNavigate={() => {
                setOpen(false);
              }}
            />
          ))}
        </>
      ) : null}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="bg-sidebar sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r p-4 md:flex print:hidden">
        <Link href="/admin" className="mb-6 px-2 text-lg font-semibold">
          {t.app.name}
        </Link>
        <div className="flex-1 overflow-y-auto">{nav}</div>
        <UserBox me={me} signOutAction={signOutAction} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background sticky top-0 z-20 flex items-center justify-between border-b px-4 py-2 md:hidden print:hidden">
          <Link href="/admin" className="font-semibold">
            {t.app.name}
          </Link>
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
          <div id="mobile-nav" className="bg-background border-b p-4 md:hidden print:hidden">
            {nav}
            <div className="mt-4">
              <UserBox me={me} signOutAction={signOutAction} />
            </div>
          </div>
        ) : null}
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-8 print:max-w-none print:p-0">
          {children}
        </main>
      </div>
    </div>
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
        "hover:bg-sidebar-accent flex items-center gap-2 rounded-md px-2 py-1.5",
        active && "bg-sidebar-accent font-medium",
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      {item.label}
    </Link>
  );
}

function UserBox({
  me,
  signOutAction,
}: {
  me: Me | null;
  signOutAction: () => Promise<void>;
}): React.JSX.Element {
  return (
    <div className="grid gap-2 border-t pt-3 text-xs">
      {me ? (
        <>
          <p className="text-muted-foreground truncate px-2" title={me.user.email}>
            {t.admin.nav.signedInAs(me.user.email)}
          </p>
          <div className="flex items-center justify-between gap-2 px-2">
            <Badge variant="secondary">{t.admin.nav.role[me.user.role]}</Badge>
            {me.company ? <span className="text-muted-foreground truncate">{me.company.name}</span> : null}
          </div>
        </>
      ) : null}
      <div className="hidden px-2 md:block">
        <LanguageSwitch />
      </div>
      <form action={signOutAction}>
        <Button type="submit" variant="ghost" size="sm" className="w-full justify-start">
          {t.app.signOut}
        </Button>
      </form>
    </div>
  );
}
