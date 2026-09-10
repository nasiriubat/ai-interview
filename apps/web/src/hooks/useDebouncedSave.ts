"use client";

import * as React from "react";
import { t } from "@/i18n";
import { errorMessage } from "@/lib/api/errors";

export type SaveState =
  { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; text: string };

/**
 * Persists a value a moment after it stops changing (settings knobs that re-render the
 * page immediately). The first render never saves; only later changes do.
 */
export function useDebouncedSave<T>(value: T, save: (value: T) => Promise<void>, delayMs = 700): SaveState {
  const [state, setState] = React.useState<SaveState>({ kind: "idle" });
  const first = React.useRef(true);
  const latest = React.useRef(save);
  latest.current = save;
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      setState({ kind: "saving" });
      latest
        .current(value)
        .then(() => {
          if (!cancelled) setState({ kind: "saved" });
        })
        .catch((e: unknown) => {
          if (!cancelled) setState({ kind: "error", text: errorMessage(e, t.app.unknownError) });
        });
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [value, delayMs]);
  return state;
}
