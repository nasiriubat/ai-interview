"use client";

import * as React from "react";
import { staffClient } from "@/lib/api/browser";
import type { SpecVersionDetail, SpecVersionSummary } from "@/lib/api/schemas";
import type { SpecVersionRef } from "@/lib/api/staff";

export const VERSION_POLL_MS = 3000;

export const isPendingVersion = (v: { status: string }): boolean =>
  v.status === "queued" || v.status === "running";

/** The version list of a session, refreshed every 3 s while any version is queued or running. */
export function useSpecVersions(
  sessionId: string,
  initial: SpecVersionSummary[],
): [SpecVersionSummary[], React.Dispatch<React.SetStateAction<SpecVersionSummary[]>>] {
  const [versions, setVersions] = React.useState(initial);
  const active = versions.some(isPendingVersion);
  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const id = setInterval(() => {
      staffClient.requirements.versions
        .list(sessionId)
        .then((list) => {
          if (!cancelled) setVersions(list);
        })
        .catch(() => undefined); // transient failure: keep polling
    }, VERSION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, sessionId]);
  return [versions, setVersions];
}

/** One version's detail, refreshed every 3 s while it is queued or running. */
export function useSpecVersionDetail(
  sessionId: string,
  v: SpecVersionRef,
  initial: SpecVersionDetail,
): SpecVersionDetail {
  const [detail, setDetail] = React.useState(initial);
  const active = isPendingVersion(detail.version);
  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const id = setInterval(() => {
      staffClient.requirements.versions
        .get(sessionId, v)
        .then((d) => {
          if (!cancelled) setDetail(d);
        })
        .catch(() => undefined);
    }, VERSION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, sessionId, v]);
  return detail;
}
