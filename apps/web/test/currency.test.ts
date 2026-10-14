import { afterEach, describe, expect, it } from "vitest";
import { safeCurrency, setClientCurrency } from "@/lib/currency";
import { formatCents } from "@/lib/utils";

/*
 * D-323. Costs were printed as euros while the provider price table is entered in US dollars, so
 * "EUR 0.48" meant 48 cents of a currency nobody had chosen. The unit is now the organization's
 * `branding.currency`, and the default is the one the prices are really in.
 */

afterEach(() => {
  setClientCurrency(null);
});

describe("formatCents", () => {
  it("prints US dollars by default, which is what the price table is in", () => {
    const text = formatCents(48);
    expect(text).toContain("0.48");
    expect(text).toMatch(/\$/);
    expect(text).not.toMatch(/€|EUR/);
  });

  it("prints the organization's currency when it names one", () => {
    setClientCurrency("EUR");
    expect(formatCents(48)).toMatch(/€/);
    setClientCurrency("SEK");
    expect(formatCents(48)).toMatch(/kr|SEK/);
  });

  it("falls back to the default for a code the runtime does not know, instead of throwing", () => {
    expect(safeCurrency("ZZZ9")).toBe("USD");
    expect(safeCurrency(undefined)).toBe("USD");
    expect(safeCurrency("usd")).toBe("USD");
    setClientCurrency("not a code");
    expect(() => formatCents(100)).not.toThrow();
  });

  it("still says nothing for a missing amount", () => {
    expect(formatCents(null)).toBe("–");
  });
});
