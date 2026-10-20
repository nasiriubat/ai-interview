import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminShell } from "@/components/admin/AdminShell";
import { PageHeader } from "@/components/admin/PageHeader";
import { buildEntries } from "@/components/admin/shell/CommandPalette";
import { parseSidebar, sidebarCookie } from "@/components/admin/shell/sidebar-state";
import { BrandingProvider } from "@/components/common/Branding";
import { notify, TOAST_MS } from "@/components/common/notify";
import type { Me } from "@/lib/api/schemas";

const push = vi.fn();
let path = "/admin/campaigns/c1";
vi.mock("next/navigation", () => ({
  usePathname: (): string => path,
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const toast = vi.hoisted(() => {
  const fn = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(() => "id"),
    dismiss: vi.fn(),
  });
  return fn;
});
vi.mock("@/components/ui/sonner", () => ({ toast, Toaster: () => null }));

const me = (role: Me["user"]["role"] = "admin"): Me => ({
  user: { id: "u1", email: "ada.lovelace@acme.test", name: "Ada Lovelace", role, companyId: "c1" },
  company: { id: "c1", name: "Acme Care" },
});

beforeEach(() => {
  push.mockReset();
  path = "/admin/campaigns/c1";
  for (const f of Object.values(toast)) if (typeof f === "function" && "mockClear" in f) f.mockClear();
});

describe("AdminShell", () => {
  it("has a labelled sidebar, a top bar with the trail, the user menu and the page", () => {
    render(
      <AdminShell me={me()}>
        <PageHeader title="Ward round" crumbLabels={{ c1: "Ward round" }} />
      </AdminShell>,
    );
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(trail).getByText("Ward round")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Account menu" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    // The section is the parent of the page being shown, so it is not marked current by the trail.
    expect(within(nav).getByRole("link", { name: "Campaigns" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("collapses to icons that keep their names, and remembers the choice in a cookie", async () => {
    const user = userEvent.setup();
    render(
      <AdminShell me={me()}>
        <p>page</p>
      </AdminShell>,
    );
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(nav).getByRole("link", { name: "Campaigns" })).toBeInTheDocument();
    expect(document.cookie).toContain("aidp-sidebar=collapsed");
    // No letter tile (D-430): with no logo the collapsed sidebar's top is the expand button, the
    // only one on the page, and focus moved to it from the toggle that went away.
    const aside = screen.getByRole("complementary", { name: "Sidebar" });
    const expand = within(aside).getByRole("button", { name: "Expand sidebar" });
    expect(screen.getAllByRole("button", { name: "Expand sidebar" })).toHaveLength(1);
    expect(expand).toHaveFocus();
    expect(within(aside).queryByText("D")).toBeNull();
    await user.click(expand);
    expect(document.cookie).toContain("aidp-sidebar=expanded");
    expect(within(aside).getByRole("link", { name: "AIScope" })).toHaveAttribute("href", "/admin");
  });

  it("shows the platform's logo instead of the name, expanded and collapsed (D-430)", async () => {
    const user = userEvent.setup();
    render(
      <BrandingProvider value={{ productName: "Askel", logoUrl: "/api/branding/logo?v=1" }}>
        <AdminShell me={me()}>
          <p>page</p>
        </AdminShell>
      </BrandingProvider>,
    );
    const aside = screen.getByRole("complementary", { name: "Sidebar" });
    const link = within(aside).getByRole("link", { name: "Askel" });
    expect(within(link).getByRole("img", { name: "Askel" })).toHaveAttribute("src", "/api/branding/logo?v=1");
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    // Collapsed, the logo stays and the top bar keeps the expand toggle.
    expect(within(aside).getByRole("img", { name: "Askel" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Expand sidebar" })).toHaveLength(1);
    expect(within(aside).queryByRole("button", { name: "Expand sidebar" })).toBeNull();
  });

  it("starts collapsed when the cookie said so", () => {
    expect(parseSidebar("collapsed")).toBe(true);
    expect(parseSidebar("expanded")).toBe(false);
    expect(parseSidebar(undefined)).toBe(false);
    expect(sidebarCookie(true)).toContain("aidp-sidebar=collapsed");
  });

  it("opens the quick search with Ctrl+K and goes to a page with Enter", async () => {
    const user = userEvent.setup();
    render(
      <AdminShell me={me()}>
        <p>page</p>
      </AdminShell>,
    );
    await user.keyboard("{Control>}k{/Control}");
    const box = await screen.findByRole("combobox", { name: "Search" });
    await user.type(box, "audit");
    expect(screen.getByRole("option", { name: "Audit log" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/admin/audit");
    });
  });

  it("offers the platform pages to the operator only", () => {
    const admin = buildEntries("admin").map((e) => e.href);
    const operator = buildEntries("platform_operator").map((e) => e.href);
    expect(admin).not.toContain("/admin/operator");
    expect(operator).toContain("/admin/operator");
    expect(buildEntries("member").map((e) => e.label)).not.toContain("New template");
  });
});

describe("notify", () => {
  it("success and info use their durations", () => {
    notify.success("Saved");
    expect(toast.success).toHaveBeenCalledWith("Saved", { duration: TOAST_MS.success });
    notify.info("Heads up");
    expect(toast.info).toHaveBeenCalledWith("Heads up", { duration: TOAST_MS.info });
  });

  it("an error with a retry stays longer and carries the action", () => {
    const retry = vi.fn();
    notify.error("Nope", { retry });
    const [text, options] = toast.error.mock.calls[0] as [
      string,
      { duration: number; action: { onClick: () => void } },
    ];
    expect(text).toBe("Nope");
    expect(options.duration).toBe(TOAST_MS.error * 2);
    options.action.onClick();
    expect(retry).toHaveBeenCalled();
  });

  it("a promise toast turns the loading toast into the result in place", async () => {
    await notify.promise(Promise.resolve(3), { loading: "Working", success: (n) => `Got ${String(n)}` });
    expect(toast.loading).toHaveBeenCalledWith("Working");
    expect(toast.success).toHaveBeenCalledWith("Got 3", { id: "id", duration: TOAST_MS.success });
    await expect(
      notify.promise(Promise.reject(new Error("bad")), { loading: "Working", success: "ok" }),
    ).rejects.toThrow("bad");
    expect(toast.error).toHaveBeenCalledWith("bad", expect.objectContaining({ id: "id" }));
  });
});
