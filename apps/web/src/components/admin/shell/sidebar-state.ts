/**
 * The sidebar's collapsed state is a per-person convenience kept in a cookie, not in storage, so
 * the server renders the right width on the first paint and the page does not jump (D-340). The
 * cookie is read by the admin layout and written by the toggle; it holds nothing else.
 */
export const SIDEBAR_COOKIE = "aidp-sidebar";
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function parseSidebar(value: string | undefined | null): boolean {
  return value === "collapsed";
}

export function sidebarCookie(collapsed: boolean): string {
  return `${SIDEBAR_COOKIE}=${collapsed ? "collapsed" : "expanded"}; path=/; max-age=${String(SIDEBAR_COOKIE_MAX_AGE)}; samesite=lax`;
}
