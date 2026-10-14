/**
 * The theme choice (D-238): System, Light or Dark. "System" is the absence of a choice: no
 * `data-theme` on <html>, and the stylesheet follows `prefers-color-scheme`. A choice is stored in
 * the browser only, as a per-viewer convenience; it never reaches the server, and the page renders
 * correctly with no storage at all.
 */
export type ThemeChoice = "system" | "light" | "dark";

export const THEME_KEY = "aidp.theme";

/**
 * Runs in <head> before the first paint, so a person who chose dark never sees a light flash. It
 * is an inline script with the request's nonce (see `lib/csp.ts`), and it must not throw: storage
 * can be blocked.
 */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export function readTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Applies the choice to the page now and remembers it where storage allows. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  try {
    if (choice === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Not remembered; the page still changed.
  }
}
