"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { t } from "@/i18n";

interface Guard {
  /** Whether any registered form has unsaved edits. */
  dirty: boolean;
  /** Reports whether the form `id` has unsaved edits. Unregistered automatically on unmount. */
  setDirty: (id: string, dirty: boolean) => void;
  /** Goes to `href`, asking first when something is unsaved. */
  navigate: (href: string) => void;
  /** Runs `proceed` now, or after the person has confirmed leaving. */
  confirmLeave: (proceed: () => void) => void;
}

const NOOP: Guard = {
  dirty: false,
  setDirty: () => undefined,
  navigate: () => undefined,
  confirmLeave: (proceed) => {
    proceed();
  },
};

const GuardContext = React.createContext<Guard>(NOOP);

function sameDocument(url: URL): boolean {
  return url.pathname === window.location.pathname && url.search === window.location.search;
}

/**
 * Stops unsaved edits being lost by accident (D-112). Forms register themselves with `useDirty`;
 * while any is dirty:
 *
 * - a click on an in-app link is held and the person is asked, because every nav link, breadcrumb
 *   and category tab is a plain `<a>` that would otherwise throw the form away silently;
 * - closing the tab, reloading or typing another address raises the browser's own prompt
 *   (`beforeunload`; its text cannot be customised, by design of the platform);
 * - code that navigates (a select that changes the page) goes through `navigate`.
 *
 * The browser's back button is not intercepted: the App Router offers no supported hook for it,
 * and a `popstate` trap would leave the URL and the page disagreeing. That is a known gap.
 */
export function DirtyGuardProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const router = useRouter();
  const ids = React.useRef(new Set<string>());
  const [dirty, setDirtyState] = React.useState(false);
  const [pending, setPending] = React.useState<(() => void) | null>(null);

  const setDirty = React.useCallback((id: string, isDirty: boolean): void => {
    if (isDirty) ids.current.add(id);
    else ids.current.delete(id);
    setDirtyState(ids.current.size > 0);
  }, []);

  const confirmLeave = React.useCallback((proceed: () => void): void => {
    if (ids.current.size === 0) proceed();
    else setPending(() => proceed);
  }, []);

  const navigate = React.useCallback(
    (href: string): void => {
      confirmLeave(() => {
        router.push(href);
      });
    },
    [confirmLeave, router],
  );

  React.useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      // Older engines show the prompt only when this legacy property is assigned.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent): void => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Same page (a hash jump, the skip link) loses nothing.
      if (sameDocument(url)) return;
      e.preventDefault();
      e.stopPropagation();
      setPending(() => () => {
        router.push(`${url.pathname}${url.search}${url.hash}`);
      });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    // Capture phase: before the router's own link handler sees the click.
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, router]);

  const value = React.useMemo<Guard>(
    () => ({ dirty, setDirty, navigate, confirmLeave }),
    [dirty, setDirty, navigate, confirmLeave],
  );

  return (
    <GuardContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={t.admin.form.leaveTitle}
        description={<p>{t.admin.form.leaveBody}</p>}
        confirmLabel={t.admin.form.leaveConfirm}
        cancelLabel={t.admin.form.leaveStay}
        onConfirm={() => {
          const go = pending;
          // What is being left is no longer dirty: without this the next navigation asks again.
          ids.current.clear();
          setDirtyState(false);
          setPending(null);
          go?.();
        }}
      />
    </GuardContext.Provider>
  );
}

/** Registers a form's unsaved state with the guard for as long as it is mounted. */
export function useDirty(id: string, isDirty: boolean): void {
  const { setDirty } = React.useContext(GuardContext);
  React.useEffect(() => {
    setDirty(id, isDirty);
  }, [id, isDirty, setDirty]);
  React.useEffect(
    () => () => {
      setDirty(id, false);
    },
    [id, setDirty],
  );
}

export function useDirtyGuard(): Guard {
  return React.useContext(GuardContext);
}
