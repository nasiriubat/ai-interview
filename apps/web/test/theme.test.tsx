import { runInNewContext } from "node:vm";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "@/components/common/ThemeToggle";
import { setClientLocale } from "@/i18n";
import { applyTheme, readTheme, THEME_BOOT_SCRIPT, THEME_KEY } from "@/lib/theme";

/*
 * The theme choice (D-238, D-485): the device's until somebody picks Light or Dark, applied at once, remembered in this browser,
 * and never able to break the page when storage is not there.
 */

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  setClientLocale("en");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("theme storage", () => {
  it("is the system's setting until somebody chooses", () => {
    expect(readTheme()).toBe("system");
  });

  it("applies a choice to <html> and remembers it", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(readTheme()).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("goes back to the system by removing the attribute and the stored value", () => {
    applyTheme("dark");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it("ignores a stored value that is not a theme", () => {
    window.localStorage.setItem(THEME_KEY, "<script>");
    expect(readTheme()).toBe("system");
  });

  it("still changes the page when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => {
      applyTheme("dark");
    }).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(readTheme()).toBe("system");
  });
});

describe("the script that runs before first paint", () => {
  // The script runs in its own context with only what the page gives it: storage and the document.
  const run = (): void => {
    runInNewContext(THEME_BOOT_SCRIPT, { localStorage: window.localStorage, document });
  };

  it("sets a stored choice on <html> and nothing else", () => {
    window.localStorage.setItem(THEME_KEY, "dark");
    run();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("does nothing for no choice or an unknown one", () => {
    run();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    window.localStorage.setItem(THEME_KEY, "purple");
    run();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("does not throw when storage does", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(run).not.toThrow();
  });

  it("is a plain string with no interpolated input", () => {
    expect(THEME_BOOT_SCRIPT).not.toMatch(/\$\{/);
    expect(THEME_BOOT_SCRIPT).toContain(JSON.stringify(THEME_KEY));
  });
});

/** Stands in for the device's setting: matchMedia is not in jsdom. */
function deviceIs(theme: "light" | "dark"): void {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string): MediaQueryList => ({
    matches: theme === "dark" && query.includes("dark"),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

describe("ThemeToggle (D-485)", () => {
  beforeEach(() => {
    if (typeof window.matchMedia !== "function")
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: () => undefined,
      });
  });

  it("shows the device's theme until somebody picks, with no third state", async () => {
    deviceIs("dark");
    render(<ThemeToggle />);
    const toggle = await screen.findByRole("button", { name: "Dark mode" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it("switches to the other theme and remembers it", async () => {
    deviceIs("light");
    const user = userEvent.setup();
    render(<ThemeToggle />);
    const toggle = await screen.findByRole("button", { name: "Dark mode" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("keeps every toggle on the page in step", async () => {
    deviceIs("light");
    const user = userEvent.setup();
    render(
      <>
        <ThemeToggle />
        <ThemeToggle showName />
      </>,
    );
    const [first, second] = await screen.findAllByRole("button", { name: "Dark mode" });
    await user.click(first!);
    expect(second).toHaveAttribute("aria-pressed", "true");
  });

  it("is named in Finnish", async () => {
    deviceIs("light");
    setClientLocale("fi");
    render(<ThemeToggle />);
    expect(await screen.findByRole("button", { name: "Tumma tila" })).toBeInTheDocument();
  });
});
