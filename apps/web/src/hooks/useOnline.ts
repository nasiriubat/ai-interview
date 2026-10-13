"use client";

import * as React from "react";

function subscribe(notify: () => void): () => void {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
}

/**
 * Whether the browser believes it has a network. `navigator.onLine` can say true while the
 * network is useless (a captive portal), so this gates a *retry button*, never a decision that the
 * server is reachable: a failed request is still the authority.
 */
export function useOnline(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}
