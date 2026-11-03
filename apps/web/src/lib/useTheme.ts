"use client";

import * as React from "react";
import {
  DARK_QUERY,
  effectiveTheme,
  readTheme,
  THEME_EVENT,
  type EffectiveTheme,
  type ThemeChoice,
} from "./theme";

/**
 * The theme in effect and the stored choice, kept current when another control or the device
 * changes it. Both are `null` on the server and the first client render, so hydration matches.
 */
export function useTheme(): { theme: EffectiveTheme | null; choice: ThemeChoice | null } {
  const [state, setState] = React.useState<{ theme: EffectiveTheme | null; choice: ThemeChoice | null }>({
    theme: null,
    choice: null,
  });
  React.useEffect(() => {
    const sync = (): void => {
      setState({ theme: effectiveTheme(), choice: readTheme() });
    };
    sync();
    window.addEventListener(THEME_EVENT, sync);
    const media = typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
    media?.addEventListener("change", sync);
    return () => {
      window.removeEventListener(THEME_EVENT, sync);
      media?.removeEventListener("change", sync);
    };
  }, []);
  return state;
}
