import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LogoPanel } from "@/components/admin/settings/LogoPanel";
import { BrandingProvider, ProductMark } from "@/components/common/Branding";
import { ParticipantBrand } from "@/components/participant/ParticipantFrame";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: (): string => "/admin/settings",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
  useSearchParams: () => new URLSearchParams(),
}));
const api = vi.hoisted(() => ({
  uploadLogo: vi.fn(),
  removeLogo: vi.fn(),
}));
vi.mock("@/lib/api/browser", () => ({ staffClient: { branding: api } }));
vi.mock("@/components/ui/sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  Toaster: () => null,
}));

beforeEach(() => {
  api.uploadLogo.mockReset();
  api.removeLogo.mockReset();
  refresh.mockReset();
});

describe("ProductMark (D-430)", () => {
  it("is the name in type with no letter tile, or the logo with the name as its alt", () => {
    const { container, rerender } = render(
      <ProductMark branding={{ productName: "Askel", logoUrl: null }} />,
    );
    expect(container.textContent).toBe("Askel");
    expect(container.querySelector("[aria-hidden]")).toBeNull();
    rerender(<ProductMark branding={{ productName: "Askel", logoUrl: "/api/branding/logo?v=1" }} />);
    expect(screen.getByRole("img", { name: "Askel" })).toHaveAttribute("src", "/api/branding/logo?v=1");
  });
});

describe("ParticipantBrand (D-436)", () => {
  it("uses the platform logo only when the interview carries the platform's own name", () => {
    const value = { productName: "Askel", logoUrl: "/api/branding/logo?v=1" };
    const { rerender } = render(
      <BrandingProvider value={value}>
        <ParticipantBrand title="Ward round" />
      </BrandingProvider>,
    );
    expect(screen.getByRole("img", { name: "Askel" })).toBeInTheDocument();
    rerender(
      <BrandingProvider value={value}>
        <ParticipantBrand title="Ward round" productName="Acme Voice" />
      </BrandingProvider>,
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Acme Voice")).toBeInTheDocument();
  });
});

describe("LogoPanel (D-433, D-434)", () => {
  const file = (name: string, type: string, size = 100): File =>
    new File([new Uint8Array(size)], name, { type });

  it("refuses an SVG or an oversized file before sending anything", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { container } = render(<LogoPanel />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(input, file("logo.svg", "image/svg+xml"));
    expect(screen.getByRole("alert")).toHaveTextContent(/Choose a PNG, JPEG or WebP image/);
    await user.upload(input, file("logo.png", "image/png", 300 * 1024));
    expect(screen.getByRole("alert")).toHaveTextContent(/256 KB or smaller/);
    expect(api.uploadLogo).not.toHaveBeenCalled();
  });

  it("uploads a PNG, previews it on light and dark, and removes it after confirmation", async () => {
    api.uploadLogo.mockResolvedValue({ productName: "Askel", hasLogo: true, logoVersion: "abc" });
    api.removeLogo.mockResolvedValue({ productName: "Askel", hasLogo: false, logoVersion: null });
    const user = userEvent.setup();
    const { container } = render(
      <BrandingProvider value={{ productName: "Askel", logoUrl: null }}>
        <LogoPanel />
      </BrandingProvider>,
    );
    expect(screen.getByText(/No logo/)).toBeInTheDocument();
    await user.upload(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      file("l.png", "image/png"),
    );
    expect(api.uploadLogo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: "Askel" })).toHaveAttribute("src", "/api/branding/logo?v=abc");
    expect(refresh).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    expect(api.removeLogo).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/No logo/)).toBeInTheDocument();
  });
});
