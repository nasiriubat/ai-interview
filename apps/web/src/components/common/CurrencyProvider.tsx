"use client";

import * as React from "react";
import { setClientCurrency } from "@/lib/currency";

/**
 * Publishes the organization's cost currency (`branding.currency`) to client components. The
 * module variable is set during render, before any child formats a figure, as `LocaleProvider` does.
 */
export function CurrencyProvider({
  currency,
  children,
}: {
  currency: string | null | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  setClientCurrency(currency);
  return <>{children}</>;
}
