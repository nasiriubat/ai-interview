"use client";

import * as React from "react";

/**
 * A countdown in whole seconds for a control that must wait (a new sign-in code). `start` begins
 * it from `seconds`; `remaining` is 0 when the control is free. One timer, cleared on unmount, so
 * a participant who leaves the step is not counted down in the background.
 */
export function useCooldown(seconds: number): { remaining: number; start: () => void } {
  const [until, setUntil] = React.useState(0);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (until <= Date.now()) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => {
      window.clearInterval(id);
    };
  }, [until]);
  const remaining = Math.max(0, Math.ceil((until - now) / 1000));
  return {
    remaining,
    start: () => {
      const at = Date.now();
      setNow(at);
      setUntil(at + seconds * 1000);
    },
  };
}
