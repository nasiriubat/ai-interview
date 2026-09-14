"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { staffClient } from "@/lib/api/browser";
import type { Analysis } from "@/lib/api/schemas";

export const ANALYSIS_POLL_MS = 5000;

/**
 * While the campaign's latest analysis is queued or running, asks the API every 5 s and
 * refreshes the server tree once it finishes (or fails). Returns the freshest view of
 * the latest analysis.
 */
export function useAnalysisPolling(campaignId: string, latest: Analysis | undefined): Analysis | undefined {
  const router = useRouter();
  const [live, setLive] = React.useState(latest);
  React.useEffect(() => {
    setLive(latest);
  }, [latest]);

  const active = live?.status === "queued" || live?.status === "running";
  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const page = await staffClient.analyses.list(campaignId, { limit: 1 });
        const head = page.items[0];
        if (cancelled || !head) return;
        setLive(head);
        if (head.status === "done" || head.status === "failed") router.refresh();
      } catch {
        // Transient failure: keep polling.
      }
    };
    const id = setInterval(() => {
      void tick();
    }, ANALYSIS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, campaignId, router]);

  return live;
}
