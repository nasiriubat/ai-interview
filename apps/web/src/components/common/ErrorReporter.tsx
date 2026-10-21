"use client";

import * as React from "react";
import { browserReporter } from "@/lib/errors/browser-report";

/**
 * Listens for what the page did not catch and reports it to the error log (D-477): uncaught
 * errors and unhandled promise rejections. Renders nothing. Mounted once, in the root layout, so
 * participants' and staff's pages alike are covered.
 */
export function ErrorReporter(): null {
  React.useEffect(() => {
    const reporter = browserReporter();
    const onError = (e: ErrorEvent): void => {
      reporter.report(e.error ?? e.message, "error", e.filename ? { source: e.filename } : {});
    };
    const onRejection = (e: PromiseRejectionEvent): void => {
      reporter.report(e.reason, "unhandledrejection");
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
