"use client";

import * as React from "react";

/** Subscribes to a media query. `false` on the server and wherever `matchMedia` does not exist. */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (notify: () => void): (() => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => {
        list.removeEventListener("change", notify);
      };
    },
    [query],
  );
  const snapshot = (): boolean =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false;
  return React.useSyncExternalStore(subscribe, snapshot, () => false);
}

/**
 * The primary pointer is a finger. On such devices Enter belongs to the keyboard's own line break
 * and only a button sends, because a phone keyboard has no Shift+Enter.
 */
export function useCoarsePointer(): boolean {
  return useMediaQuery("(pointer: coarse)");
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
