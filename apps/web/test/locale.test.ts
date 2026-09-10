import { describe, expect, it } from "vitest";
import { DICTIONARIES, setClientLocale, t } from "@/i18n";
import { en } from "@/i18n/en";
import { fi } from "@/i18n/fi";
import { parseAcceptLanguage, resolveLocale } from "@/i18n/locale";

describe("parseAcceptLanguage", () => {
  it("orders tags by quality and keeps header order for ties", () => {
    expect(parseAcceptLanguage("fi-FI,fi;q=0.9,en-US;q=0.8,en;q=0.7")).toEqual([
      "fi-fi",
      "fi",
      "en-us",
      "en",
    ]);
    expect(parseAcceptLanguage("en;q=0.5, fi")).toEqual(["fi", "en"]);
  });

  it("drops empty and zero-quality entries", () => {
    expect(parseAcceptLanguage("sv;q=0, , de")).toEqual(["de"]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
  });
});

describe("resolveLocale", () => {
  it("prefers the lang cookie", () => {
    expect(resolveLocale({ cookie: "fi", acceptLanguage: "en" })).toBe("fi");
    expect(resolveLocale({ cookie: "en", acceptLanguage: "fi" })).toBe("en");
  });

  it("ignores unsupported cookie values", () => {
    expect(resolveLocale({ cookie: "sv", acceptLanguage: "fi-FI" })).toBe("fi");
    expect(resolveLocale({ cookie: "", acceptLanguage: "fi" })).toBe("fi");
  });

  it("matches Accept-Language on the primary subtag in quality order", () => {
    expect(resolveLocale({ acceptLanguage: "sv-SE,fi-FI;q=0.8,en;q=0.5" })).toBe("fi");
    expect(resolveLocale({ acceptLanguage: "de-DE,en-GB;q=0.9,fi;q=0.8" })).toBe("en");
  });

  it("falls back to English", () => {
    expect(resolveLocale({})).toBe("en");
    expect(resolveLocale({ acceptLanguage: "de,sv" })).toBe("en");
    expect(resolveLocale({ cookie: null, acceptLanguage: null })).toBe("en");
  });
});

describe("t proxy", () => {
  it("resolves leaves against the active client locale, including module-scope shortcuts", () => {
    const shortcut = t.admin.campaigns;
    setClientLocale("en");
    expect(t.app.save).toBe(en.app.save);
    expect(shortcut.title).toBe(en.admin.campaigns.title);
    expect(t.participant.arrival.minutes(5)).toBe(en.participant.arrival.minutes(5));
    setClientLocale("fi");
    expect(t.app.save).toBe(fi.app.save);
    expect(shortcut.title).toBe(fi.admin.campaigns.title);
    expect(t.participant.arrival.minutes(5)).toBe(fi.participant.arrival.minutes(5));
    expect(Object.keys(t.admin.settings.categories)).toEqual(Object.keys(en.admin.settings.categories));
    setClientLocale("en");
  });

  it("has the same key shape in every dictionary", () => {
    const shape = (o: unknown, path = ""): string[] => {
      if (o === null || typeof o !== "object") return [path];
      return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        shape(v, path ? `${path}.${k}` : k),
      );
    };
    const enKeys = shape(en).sort();
    for (const dict of Object.values(DICTIONARIES)) {
      expect(shape(dict).sort()).toEqual(enKeys);
    }
  });
});
