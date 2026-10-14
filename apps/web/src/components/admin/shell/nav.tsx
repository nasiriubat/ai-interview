import {
  ActivityIcon,
  BuildingIcon,
  ClipboardListIcon,
  CoinsIcon,
  FileTextIcon,
  HeartPulseIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  MegaphoneIcon,
  MessageSquareTextIcon,
  RouteIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { t } from "@/i18n";
import type { Role } from "@/lib/api/schemas";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Active only on this exact path, not on its children. */
  exact?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/*
 * Functions, not module constants: a label read at module load takes the locale of whoever imported
 * the module first (the server's default), and every later request would render the sidebar in it.
 */
export function mainNav(): NavGroup[] {
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

export function operatorNav(): NavItem[] {
  return [
    { href: "/admin/operator", label: t.admin.nav.tenants, icon: BuildingIcon, exact: true },
    { href: "/admin/operator/providers", label: t.admin.nav.platformProviders, icon: ServerIcon },
    { href: "/admin/operator/routes", label: t.admin.nav.platformRoutes, icon: RouteIcon },
    { href: "/admin/operator/stats", label: t.admin.nav.platformStats, icon: ActivityIcon },
    { href: "/admin/operator/health", label: t.admin.nav.platformHealth, icon: HeartPulseIcon },
    { href: "/admin/operator/jobs", label: t.admin.nav.platformJobs, icon: ListChecksIcon },
  ];
}

/** The groups a person sees: the tenant's, plus the platform's for an operator. */
export function navFor(role: Role | undefined): NavGroup[] {
  const main = mainNav();
  return role === "platform_operator"
    ? [...main, { label: t.admin.nav.operator, items: operatorNav() }]
    : main;
}

export function isActive(item: NavItem, pathname: string): boolean {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** What the command palette can do beyond going to a page. Roles that cannot do it never see it. */
export interface PaletteAction {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
}

export function paletteActions(role: Role | undefined): PaletteAction[] {
  const p = t.kit.shell.palette;
  const actions: PaletteAction[] = [
    { id: "new-campaign", label: p.newCampaign, href: "/admin/campaigns/new", icon: MegaphoneIcon },
    {
      id: "new-requirement",
      label: p.newRequirement,
      href: "/admin/requirements/new",
      icon: ClipboardListIcon,
    },
  ];
  if (role === "admin" || role === "platform_operator") {
    actions.push({
      id: "new-template",
      label: p.newTemplate,
      href: "/admin/templates/new",
      icon: FileTextIcon,
    });
  }
  return actions;
}

/** Case-insensitive match over words: every typed word must start a word of the label. */
export function matchesQuery(label: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = label.toLowerCase().split(/[\s/·-]+/);
  return words.every((w) => haystack.some((h) => h.startsWith(w)));
}
