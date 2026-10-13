"use client";

import { usePathname, useSearchParams } from "next/navigation";
import * as React from "react";

/**
 * A thin bar across the top of the window while a page is loading (D-78).
 *
 * The App Router has no "navigation started" event, so this listens for the thing that starts
 * one: a click on an internal link. It finishes when the URL actually changes, and gives up after
 * `GIVE_UP_MS` so a click that never navigates (a link to the page already open, a server error)
 * cannot leave a bar crawling forever. Code that navigates programmatically, or a form whose
 * action redirects, can call `startNavigationProgress()`.
 *
 * It is decoration for sighted users: route changes are already announced by Next's route
 * announcer, so the bar is `aria-hidden` rather than a second, competing announcement.
 */
const GIVE_UP_MS = 10_000;
const START_EVENT = "aidp:navigation-start";

export function startNavigationProgress(): void {
  window.dispatchEvent(new Event(START_EVENT));
}

function isInternalNavigation(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const anchor = (event.target as Element | null)?.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  if (anchor.hasAttribute("download")) return false;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return false;
  // Same page, different hash: the browser scrolls, nothing loads.
  return url.pathname !== window.location.pathname || url.search !== window.location.search;
}

export function NavigationProgress(): React.JSX.Element {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [progress, setProgress] = React.useState<number | null>(null);
  const timers = React.useRef<{ trickle?: number; giveUp?: number; hide?: number }>({});

  const clear = React.useCallback(() => {
    window.clearInterval(timers.current.trickle);
    window.clearTimeout(timers.current.giveUp);
    window.clearTimeout(timers.current.hide);
  }, []);

  const finish = React.useCallback(() => {
    clear();
    setProgress((p) => (p === null ? null : 100));
    timers.current.hide = window.setTimeout(() => {
      setProgress(null);
    }, 250);
  }, [clear]);

  const start = React.useCallback(() => {
    clear();
    setProgress(8);
    // Approaches 90% and never reaches it: the real end is the URL changing.
    timers.current.trickle = window.setInterval(() => {
      setProgress((p) => (p === null ? null : p + (90 - p) * 0.12));
    }, 200);
    timers.current.giveUp = window.setTimeout(finish, GIVE_UP_MS);
  }, [clear, finish]);

  React.useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      if (isInternalNavigation(e)) start();
    };
    document.addEventListener("click", onClick, { capture: true });
    window.addEventListener(START_EVENT, start);
    return () => {
      document.removeEventListener("click", onClick, { capture: true });
      window.removeEventListener(START_EVENT, start);
      clear();
    };
  }, [start, clear]);

  React.useEffect(() => {
    finish();
  }, [pathname, search, finish]);

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-[200] h-0.5 print:hidden">
      <div
        data-testid="navigation-progress"
        className="bg-primary h-full shadow-[0_0_8px_var(--primary)] motion-safe:transition-[width,opacity] motion-safe:duration-200"
        style={{ width: `${progress ?? 0}%`, opacity: progress === null || progress >= 100 ? 0 : 1 }}
      />
    </div>
  );
}
