/**
 * The theme choice (D-238, D-485): Light or Dark, and until somebody picks one, the device's own
 * setting. "system" is the absence of a choice: no `data-theme` on <html>, and the stylesheet follows
 * `prefers-color-scheme`. Quick controls show only the theme in effect (light or dark) and switch to
 * the other; the account page can go back to following the device. A choice is stored in the
 * browser only, as a per-viewer convenience; it never reaches the server, and the page renders
 * correctly with no storage at all.
 */
export type ThemeChoice = "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";

/** Fired on window when a control changes the theme, so every control on the page follows. */
export const THEME_EVENT = "aidp:theme";

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
  window.dispatchEvent(new Event(THEME_EVENT));
}

export const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The device's own preference; light where the browser cannot say. */
export function deviceTheme(): EffectiveTheme {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** The theme on screen: what <html> says, else the device's. Read from the page, not from storage. */
export function effectiveTheme(): EffectiveTheme {
  const set = document.documentElement.getAttribute("data-theme");
  return set === "light" || set === "dark" ? set : deviceTheme();
}
