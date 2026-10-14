import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToasterHost } from "@/components/common/ToasterHost";

/*
 * Sonner injects a <style> element when its module is evaluated, which the nonce policy reports.
 * The landing page must not load it at all; every other page still gets its toast region.
 */

const state = vi.hoisted(() => ({ pathname: "/", loaded: 0 }));

vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("@/components/ui/sonner", () => {
  state.loaded++;
  return { Toaster: () => <div data-testid="toaster" /> };
});

beforeEach(() => {
  state.pathname = "/";
});

describe("the toast region", () => {
  it("is not mounted, and its library not loaded, on the landing page", () => {
    const before = state.loaded;
    const { container } = render(<ToasterHost />);
    expect(container).toBeEmptyDOMElement();
    expect(state.loaded).toBe(before);
  });

  it("is mounted on every other page", async () => {
    state.pathname = "/auth/signin";
    render(<ToasterHost />);
    expect(await screen.findByTestId("toaster")).toBeInTheDocument();
  });
});
