import { cache } from "react";

/*
 * The currency every cost is shown in (D-323). The ledger holds hundredths of the unit the price
 * table was entered in; `branding.currency` says what that unit is, and the API hands it over with
 * `GET /me`. Same shape as the locale (`@/i18n`): a per-request store on the server, set by `getMe`,
 * and a module variable in the browser, set by `CurrencyProvider` during render.
 */

export const DEFAULT_CURRENCY = "USD";

const requestStore = cache((): { currency: string | null } => ({ currency: null }));

let clientCurrency: string | null = null;

/** An ISO 4217 code `Intl` accepts; anything else falls back to the default rather than throwing. */
export function safeCurrency(code: string | null | undefined): string {
  if (typeof code === "string" && /^[A-Z]{3}$/.test(code)) {
    try {
      new Intl.NumberFormat("en", { style: "currency", currency: code });
      return code;
    } catch {
      // not a currency this runtime knows
    }
  }
  return DEFAULT_CURRENCY;
}

export function currentCurrency(): string {
  if (clientCurrency) return clientCurrency;
  try {
    const c = requestStore().currency;
    if (c) return c;
  } catch {
    // Outside a React request scope: the default applies.
  }
  return DEFAULT_CURRENCY;
}

/** Called on the server once the signed-in user's company is known. */
export function setRequestCurrency(code: string | null | undefined): void {
  try {
    requestStore().currency = safeCurrency(code);
  } catch {
    // Not in a request scope; nothing to store.
  }
}

/** Called by `CurrencyProvider` so browser-side figures follow the server's choice. */
export function setClientCurrency(code: string | null | undefined): void {
  clientCurrency = safeCurrency(code);
}
