"use client";

import * as React from "react";
import {
  refusalFor,
  refusalMessage,
  uploadErrorMessage,
  type UploadItem,
  type UploadRules,
} from "@/lib/upload";

export interface UploadContext {
  signal: AbortSignal;
  /** 0 to 100. An adapter that cannot measure progress never calls it and the bar stays indeterminate. */
  onProgress: (percent: number) => void;
}

export interface UploadQueueOptions<R> {
  rules: UploadRules;
  /** How many files may be added in total while the list is shown; 1 makes it a single-file picker. */
  maxFiles?: number | undefined;
  /** Files sent at the same time. */
  concurrency?: number;
  upload: (file: File, ctx: UploadContext) => Promise<R>;
  onUploaded?: (result: R, file: File) => void;
}

export interface UploadQueue<R> {
  items: UploadItem<R>[];
  add: (files: readonly File[]) => void;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
}

let counter = 0;
const nextId = (): string => `up-${String((counter += 1))}`;

/**
 * The state machine of a file upload (D-343): each file is validated, queued, sent with a progress
 * callback and an abort signal, and ends `done`, `failed` (with a reason, retryable) or
 * `cancelled`. Refused files appear in the list as failed rows so the person sees which one and
 * why, instead of a file silently vanishing.
 */
export function useUploadQueue<R>(options: UploadQueueOptions<R>): UploadQueue<R> {
  const { rules, maxFiles, concurrency = 2 } = options;
  const [items, setItems] = React.useState<UploadItem<R>[]>([]);
  const controllers = React.useRef(new Map<string, AbortController>());
  const latest = React.useRef(options);
  latest.current = options;
  const maxMb = Math.round((rules.maxBytes / (1024 * 1024)) * 10) / 10;

  const patch = React.useCallback((id: string, change: Partial<UploadItem<R>>): void => {
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...change } : i)));
  }, []);

  const start = React.useCallback(
    (item: UploadItem<R>): void => {
      // The effect can run twice before the state it set has rendered (Strict Mode does).
      if (controllers.current.has(item.id)) return;
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      patch(item.id, { status: "uploading", progress: 0 });
      latest.current
        .upload(item.file, {
          signal: controller.signal,
          onProgress: (p) => {
            patch(item.id, { progress: p });
          },
        })
        .then((result) => {
          patch(item.id, { status: "done", progress: 100, result });
          latest.current.onUploaded?.(result, item.file);
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) {
            patch(item.id, { status: "cancelled", progress: 0 });
            return;
          }
          patch(item.id, { status: "failed", error: uploadErrorMessage(e, maxMb) });
        })
        .finally(() => {
          controllers.current.delete(item.id);
        });
    },
    [maxMb, patch],
  );

  // Start waiting files while there is room. Runs after every state change.
  React.useEffect(() => {
    const running = items.filter((i) => i.status === "uploading").length;
    const waiting = items.filter((i) => i.status === "waiting");
    const room = Math.max(0, concurrency - running);
    for (const item of waiting.slice(0, room)) start(item);
  }, [items, concurrency, start]);

  const add = React.useCallback(
    (files: readonly File[]): void => {
      setItems((list) => {
        const out = [...list];
        let kept = list.filter((i) => i.status !== "cancelled").length;
        for (const file of files) {
          const id = nextId();
          if (maxFiles !== undefined && kept >= maxFiles) {
            out.push({
              id,
              file,
              status: "failed",
              progress: 0,
              error: refusalMessage("too_many", maxMb, maxFiles),
            });
            continue;
          }
          const refusal = refusalFor(file, rules);
          if (refusal) {
            out.push({ id, file, status: "failed", progress: 0, error: refusalMessage(refusal, maxMb) });
          } else {
            out.push({ id, file, status: "waiting", progress: 0 });
            kept += 1;
          }
        }
        return out;
      });
    },
    [maxFiles, maxMb, rules],
  );

  const cancel = React.useCallback(
    (id: string): void => {
      const controller = controllers.current.get(id);
      if (controller) controller.abort();
      else patch(id, { status: "cancelled", progress: 0 });
    },
    [patch],
  );

  const retry = React.useCallback(
    (id: string): void => {
      setItems((list) =>
        list.map((i) => {
          if (i.id !== id) return i;
          const rest = { ...i };
          delete rest.error;
          const refusal = refusalFor(i.file, rules);
          return refusal
            ? { ...i, status: "failed", error: refusalMessage(refusal, maxMb) }
            : { ...rest, status: "waiting", progress: 0 };
        }),
      );
    },
    [maxMb, rules],
  );

  const remove = React.useCallback((id: string): void => {
    controllers.current.get(id)?.abort();
    setItems((list) => list.filter((i) => i.id !== id));
  }, []);

  const clearFinished = React.useCallback((): void => {
    setItems((list) => list.filter((i) => i.status === "uploading" || i.status === "waiting"));
  }, []);

  React.useEffect(
    () => () => {
      for (const c of controllers.current.values()) c.abort();
    },
    [],
  );

  return { items, add, cancel, retry, remove, clearFinished };
}
