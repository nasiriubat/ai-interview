"use client";

import { ArrowDownIcon } from "lucide-react";
import * as React from "react";
import { usePrefersReducedMotion } from "@/hooks/useMediaQuery";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/** Within this many pixels of the end counts as "at the end": a thumb flick is never exact. */
const STUCK_PX = 72;

/**
 * The scrolling part of a conversation, behaving the way a messenger does.
 *
 * - Content is anchored to the bottom: a short conversation sits directly above the composer.
 * - New content follows the end only while the person is at the end. Scrolled up to read, they stay
 *   put, and a "Jump to latest" pill counts what arrived meanwhile.
 * - Text that streams in grows the last bubble without moving the page: following is an instant
 *   pin, never an animation, so there is nothing to jump.
 * - Older content that loads above does not move what is being read (the browser's scroll anchoring
 *   keeps the visible part where it is; nothing here fights it).
 *
 * The scroller is the only thing on the page that scrolls; its parent gives it a height.
 */
export function ChatViewport({
  children,
  count,
  contentKey,
  className,
  innerClassName,
}: {
  children: React.ReactNode;
  /** How many messages there are; growth while scrolled up is what the pill counts. */
  count: number;
  /** Changes whenever the content does without the count changing (streaming, typing, widgets). */
  contentKey: string;
  className?: string;
  innerClassName?: string;
}): React.JSX.Element {
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const stuck = React.useRef(true);
  const seenCount = React.useRef(count);
  const reduceMotion = usePrefersReducedMotion();
  const [away, setAway] = React.useState(false);
  const [unread, setUnread] = React.useState(0);

  const toEnd = React.useCallback((smooth: boolean): void => {
    const el = scrollerRef.current;
    if (!el) return;
    if (typeof el.scrollTo === "function")
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    else el.scrollTop = el.scrollHeight;
  }, []);

  const lastTop = React.useRef(0);
  const onScroll = (): void => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const up = el.scrollTop < lastTop.current - 1;
    lastTop.current = el.scrollTop;
    // Only the person moving up, or being at the end again, changes whether the end is followed.
    // Content growing under a stationary view (a font arriving, a clip drawing) must not look like
    // "scrolled away", or the pin would be given up exactly when it is needed.
    if (distance <= STUCK_PX) {
      stuck.current = true;
      setAway(false);
      setUnread(0);
    } else if (up) {
      stuck.current = false;
      setAway(true);
    }
  };

  // First paint: the end, at once, before anything is shown.
  React.useLayoutEffect(() => {
    toEnd(false);
  }, [toEnd]);

  // New messages: follow if at the end, otherwise count them.
  React.useEffect(() => {
    const added = count - seenCount.current;
    seenCount.current = count;
    if (added <= 0) return;
    if (stuck.current) toEnd(!reduceMotion);
    else setUnread((n) => n + added);
  }, [count, toEnd, reduceMotion]);

  // Anything that changes the height of the content (streaming text, a widget, the keyboard
  // resizing the viewport) keeps a person who is at the end at the end.
  React.useEffect(() => {
    const content = contentRef.current;
    const scroller = scrollerRef.current;
    if (!content || !scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stuck.current) toEnd(false);
    });
    observer.observe(content);
    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, [toEnd]);

  React.useEffect(() => {
    if (stuck.current) toEnd(false);
  }, [contentKey, toEnd]);

  const s = t.participant.session;
  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        data-chat-scroller=""
        // Focusable so a keyboard user can scroll the conversation with the arrow keys.
        tabIndex={0}
        className="absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        <div className="flex min-h-full flex-col justify-end">
          <div
            ref={contentRef}
            className={cn("mx-auto w-full max-w-[780px] px-4 py-6 sm:px-6", innerClassName)}
          >
            {children}
          </div>
        </div>
      </div>
      {away ? (
        <button
          type="button"
          onClick={() => {
            stuck.current = true;
            setUnread(0);
            setAway(false);
            toEnd(!reduceMotion);
          }}
          className="bg-card text-foreground shadow-raised absolute bottom-3 left-1/2 inline-flex min-h-10 -translate-x-1/2 items-center gap-2 rounded-full px-4 text-sm font-medium"
        >
          <ArrowDownIcon className="size-4" aria-hidden="true" />
          {unread > 0 ? s.jumpToLatestUnread(unread) : s.jumpToLatest}
        </button>
      ) : null}
    </div>
  );
}
