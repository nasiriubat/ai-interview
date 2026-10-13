import { act, render, renderHook, screen } from "@testing-library/react";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Flash, useAction } from "@/components/admin/Flash";
import { NavigationProgress } from "@/components/common/NavigationProgress";
import { Button } from "@/components/ui/button";
import { buildCrumbs } from "@/lib/admin/breadcrumbs";
import { dailySeries, dashboardNumbers } from "@/lib/admin/dashboard";

const toastSuccess = vi.fn<(text: string) => void>();
vi.mock("sonner", () => ({
  toast: {
    success: (text: string) => {
      toastSuccess(text);
    },
  },
  Toaster: () => null,
}));

let pathname = "/admin/campaigns";
let search = "";
vi.mock("next/navigation", () => ({
  usePathname: (): string => pathname,
  useSearchParams: (): URLSearchParams => new URLSearchParams(search),
}));

beforeEach(() => {
  toastSuccess.mockReset();
  pathname = "/admin/campaigns";
  search = "";
});

describe("buildCrumbs", () => {
  it("is empty outside the admin and a single crumb on the dashboard", () => {
    expect(buildCrumbs("/p/session")).toEqual([]);
    expect(buildCrumbs("/admin")).toEqual([{ label: "Dashboard" }]);
  });

  it("links every ancestor and leaves the current page unlinked", () => {
    expect(buildCrumbs("/admin/campaigns/new")).toEqual([
      { label: "Dashboard", href: "/admin" },
      { label: "Campaigns", href: "/admin/campaigns" },
      { label: "New" },
    ]);
  });

  it("names id segments from the labels the page supplies, never showing the id", () => {
    expect(buildCrumbs("/admin/campaigns/c_123/results", { c_123: "Q3 survey" })).toEqual([
      { label: "Dashboard", href: "/admin" },
      { label: "Campaigns", href: "/admin/campaigns" },
      { label: "Q3 survey", href: "/admin/campaigns/c_123" },
      { label: "Results" },
    ]);
    const unnamed = buildCrumbs("/admin/templates/t_9");
    expect(unnamed.map((c) => c.label)).toEqual(["Dashboard", "Templates", "Details"]);
  });

  it("does not link namespaces that have no page, and names versions", () => {
    const crumbs = buildCrumbs("/admin/requirements/r1/versions/3", { r1: "Payroll app" });
    expect(crumbs.map((c) => c.label)).toEqual([
      "Dashboard",
      "Requirements",
      "Payroll app",
      "Versions",
      "Version 3",
    ]);
    expect(crumbs[3]?.href).toBeUndefined();
    const session = buildCrumbs("/admin/sessions/s1/");
    expect(session[1]).toEqual({ label: "Sessions" });
  });

  it("uses the operator section names", () => {
    expect(buildCrumbs("/admin/operator/providers").map((c) => c.label)).toEqual([
      "Dashboard",
      "Tenants",
      "Platform providers",
    ]);
  });
});

describe("dashboardNumbers", () => {
  const stats = {
    participation: {
      campaigns: { open: 3, draft: 1, closed: 2 },
      sessions: { created: 5, consented: 1, active: 17, paused: 0, completed: 7, deleted: 4 },
      invited: 12,
    },
    ai: {
      month: {
        costCents: 1412.6,
        calls: 100,
        inputTokens: 1000,
        outputTokens: 500,
        cacheHitRate: 0.25,
        avgLatencyMs: 1500,
        byStatus: { ok: 90, error: 8, timeout: 2 },
      },
      budget: null,
    },
  };

  it("counts started interviews without the ones never opened or deleted", () => {
    const n = dashboardNumbers(stats);
    expect(n.campaigns).toEqual({ open: 3, total: 6 });
    expect(n.interviews).toMatchObject({ invited: 12, started: 25, active: 17, completed: 7 });
    expect(n.interviews?.completionRate).toBeCloseTo(7 / 25);
  });

  it("derives the failure rate from calls that did not end ok", () => {
    expect(dashboardNumbers(stats).ai?.errorRate).toBeCloseTo(0.1);
  });

  it("tolerates a payload missing whole groups", () => {
    expect(dashboardNumbers({})).toEqual({ campaigns: null, interviews: null, ai: null });
    const noCalls = dashboardNumbers({ ai: { month: { ...stats.ai.month, calls: 0, byStatus: {} } } });
    expect(noCalls.ai?.errorRate).toBeNull();
  });
});

describe("dailySeries", () => {
  it("fills every day of the window, oldest first, with zeros where nothing was spent", () => {
    const now = new Date("2026-09-21T10:00:00Z");
    const out = dailySeries([{ key: "2026-09-20", costCents: 50, calls: 2 }], 3, now);
    expect(out).toEqual([
      { day: "2026-09-19", costCents: 0, calls: 0 },
      { day: "2026-09-20", costCents: 50, calls: 2 },
      { day: "2026-09-21", costCents: 0, calls: 0 },
    ]);
  });
});

describe("Button loading", () => {
  it("disables the button, marks it busy and shows a spinner", () => {
    render(<Button loading>Save</Button>);
    const b = screen.getByRole("button", { name: "Save" });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute("aria-busy", "true");
    expect(b.querySelector(".animate-spin")).not.toBeNull();
  });

  it("is an ordinary button otherwise", () => {
    render(<Button>Save</Button>);
    const b = screen.getByRole("button", { name: "Save" });
    expect(b).toBeEnabled();
    expect(b).not.toHaveAttribute("aria-busy");
  });
});

describe("useAction feedback", () => {
  it("confirms success with a toast and keeps nothing inline", async () => {
    const { result } = renderHook(() => useAction());
    await act(async () => {
      await result.current.run(() => Promise.resolve(), "Saved");
    });
    expect(toastSuccess).toHaveBeenCalledWith("Saved");
    expect(result.current.flash).toBeNull();
  });

  it("keeps an error inline, next to the form, and does not toast it", async () => {
    const { result } = renderHook(() => useAction());
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("Budget must be positive");
      });
    });
    expect(toastSuccess).not.toHaveBeenCalled();
    render(<Flash flash={result.current.flash} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Budget must be positive");
  });
});

describe("NavigationProgress", () => {
  it("starts on an internal link click and finishes when the URL changes", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <>
        <NavigationProgress />
        <a href="/admin/templates">Templates</a>
        <a href="https://example.com/x">External</a>
      </>,
    );
    const bar = screen.getByTestId("navigation-progress");
    const link = screen.getByText("External");
    link.addEventListener("click", (e) => {
      e.preventDefault();
    });
    act(() => {
      link.click();
    });
    expect(bar.style.opacity).toBe("0");

    const internal = screen.getByText("Templates");
    internal.addEventListener("click", (e) => {
      e.preventDefault();
    });
    act(() => {
      internal.click();
      vi.advanceTimersByTime(400);
    });
    expect(bar.style.opacity).toBe("1");

    pathname = "/admin/templates";
    rerender(
      <>
        <NavigationProgress />
        <a href="/admin/templates">Templates</a>
      </>,
    );
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(bar.style.opacity).toBe("0");
    vi.useRealTimers();
  });
});
