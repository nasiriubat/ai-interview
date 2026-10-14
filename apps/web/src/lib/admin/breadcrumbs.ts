import { t } from "@/i18n";

export interface Crumb {
  label: string;
  /** Absent for the current page and for segments that have no page of their own. */
  href?: string | undefined;
}

/** Top-level admin sections, by their path. */
function sectionLabels(): Record<string, string> {
  const n = t.admin.nav;
  return {
    "/admin/templates": n.templates,
    "/admin/campaigns": n.campaigns,
    "/admin/requirements": n.requirements,
    "/admin/settings": n.settings,
    "/admin/providers": n.providers,
    "/admin/routes": n.routes,
    "/admin/budgets": n.budgets,
    "/admin/prompts": n.prompts,
    "/admin/users": n.users,
    "/admin/audit": n.audit,
    "/admin/account": t.kit.account.title,
    "/admin/operator": n.tenants,
    "/admin/operator/providers": n.platformProviders,
    "/admin/operator/routes": n.platformRoutes,
    "/admin/operator/stats": n.platformStats,
    "/admin/operator/jobs": n.platformJobs,
    "/admin/operator/health": n.platformHealth,
  };
}

/**
 * Path segments that name a fixed sub-page, and those that are only a namespace in the URL with
 * no page behind them (`/admin/sessions` does not exist; a session is reached from its campaign).
 */
function fixedSegment(segment: string): { label: string; linkable: boolean } | undefined {
  const c = t.admin.crumbs;
  const map: Record<string, { label: string; linkable: boolean }> = {
    new: { label: c.new, linkable: true },
    edit: { label: c.edit, linkable: true },
    results: { label: c.results, linkable: true },
    report: { label: c.report, linkable: true },
    versions: { label: c.versions, linkable: false },
    sessions: { label: c.sessions, linkable: false },
  };
  return map[segment];
}

/**
 * The trail from the dashboard to the current page, derived from the URL (D-78). An id segment
 * shows the entity's name when the page supplies it in `labels` (keyed by the raw segment), and a
 * neutral "Details" otherwise — never the id itself, which means nothing to a reader.
 */
export function buildCrumbs(pathname: string, labels: Record<string, string> = {}): Crumb[] {
  const clean = pathname.replace(/\/+$/, "");
  const segments = clean.split("/").filter(Boolean);
  if (segments[0] !== "admin") return [];
  const sections = sectionLabels();
  const crumbs: Crumb[] = [{ label: t.admin.nav.dashboard, href: "/admin" }];
  let path = "/admin";
  for (const [i, segment] of segments.entries()) {
    if (i === 0) continue;
    const previous = segments[i - 1];
    path += `/${segment}`;
    const section = sections[path];
    const fixed = fixedSegment(segment);
    let crumb: Crumb;
    const named = labels[segment];
    if (named !== undefined) {
      crumb = { label: named, href: path };
    } else if (section !== undefined) {
      crumb = { label: section, href: path };
    } else if (previous === "versions") {
      crumb = { label: t.admin.crumbs.version(segment), href: path };
    } else if (fixed !== undefined) {
      crumb = { label: fixed.label, ...(fixed.linkable ? { href: path } : {}) };
    } else {
      crumb = { label: t.admin.crumbs.details, href: path };
    }
    crumbs.push(crumb);
  }
  // The last crumb is the page you are on: shown, not linked.
  const last = crumbs[crumbs.length - 1];
  if (last) delete last.href;
  return crumbs;
}
