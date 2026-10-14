"use client";

import { WifiOffIcon } from "lucide-react";
import * as React from "react";
import { useOnline } from "@/hooks/useOnline";
import { t } from "@/i18n";

/**
 * A fixed notice at the bottom of every page while the browser reports no network (D-391). It does
 * not block anything: a request that fails still says so where it was made. The live region is
 * always mounted, so the change is announced; the visible bar only exists while offline.
 */
export function OfflineBanner(): React.JSX.Element {
  const online = useOnline();
  return (
    <div role="status" aria-live="polite" className="print:hidden">
      {online ? null : (
        <div className="bg-foreground text-background fixed inset-x-3 bottom-3 z-[90] mx-auto flex max-w-xl items-center gap-3 rounded-lg px-4 py-3 text-sm shadow-lg">
          <WifiOffIcon className="size-4 shrink-0" aria-hidden="true" />
          {t.kit.states.offline.banner}
        </div>
      )}
    </div>
  );
}
