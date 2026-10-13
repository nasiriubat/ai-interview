import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import type * as React from "react";
import type * as ReactTypes from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import { fi } from "@/i18n/fi";
import { ApiError } from "@/lib/api/errors";

/*
 * What this guards (status review 2026-10-13, item 7): the per-request locale lives in a React
 * `cache` store that only the root layout fills. A page and its layout render concurrently, so a
 * page that read `t` without awaiting the locale itself rendered English under `lang=fi`, while its
 * client islands rendered Finnish. Under Vitest there is no request scope, so `cache` is stood in
 * for by a memo that is reset per test, which is exactly one "request". Each test renders the page
 * WITHOUT the layout, i.e. in the ordering where the layout has not yet resolved the locale.
 */

const request = vi.hoisted(() => {
  const state: { memo: Map<unknown, unknown>; cookie: string | undefined } = {
    memo: new Map<unknown, unknown>(),
    cookie: "fi",
  };
  return state;
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactTypes>();
  const cache =
    <A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) =>
    (...args: A): R => {
      if (!request.memo.has(fn)) request.memo.set(fn, fn(...args));
      return request.memo.get(fn) as R;
    };
  return { ...actual, cache };
});

vi.mock("next/headers", () => ({
  cookies: (): Promise<{ get: (name: string) => { value: string } | undefined }> =>
    Promise.resolve({
      get: (name: string) => (name === "lang" && request.cookie ? { value: request.cookie } : undefined),
    }),
  headers: (): Promise<{ get: () => null }> => Promise.resolve({ get: () => null }),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const api = vi.hoisted(() => ({
  hasToken: false,
  getLink: vi.fn(),
  getInvite: vi.fn(),
  staffToken: undefined as string | undefined,
}));

vi.mock("@/lib/api/server", () => ({
  participantServer: () => Promise.resolve({ api: {}, hasToken: api.hasToken }),
  publicTransport: () => ({}),
  staffServer: () => Promise.resolve({ users: { list: () => Promise.resolve({ items: [], total: 0 }) } }),
  staffTokenFromCookies: () => Promise.resolve(api.staffToken),
}));

vi.mock("@/lib/api/participant", () => ({
  participantApi: () => ({ getLink: api.getLink, getInvite: api.getInvite }),
}));

vi.mock("@/lib/admin/me", () => ({
  requireMe: () => Promise.resolve(null),
  getMe: () => Promise.resolve({ ok: false, reason: "unavailable" }),
  hasRole: () => false,
}));

vi.mock("@/auth", () => ({ signIn: vi.fn(), signOut: vi.fn(), auth: vi.fn() }));
vi.mock("@/app/auth/actions", () => ({ signInWithEmail: vi.fn(), signInWithGoogle: vi.fn() }));
vi.mock("@/app/admin/actions", () => ({ signOutAction: vi.fn() }));

beforeEach(() => {
  request.memo.clear();
  request.cookie = "fi";
  api.hasToken = false;
  api.staffToken = undefined;
  api.getLink.mockReset();
  api.getInvite.mockReset();
});

async function renderPage(element: Promise<React.JSX.Element> | React.JSX.Element): Promise<void> {
  render(await element);
}

describe("server pages follow the lang cookie", () => {
  it("participant session screen: expired link in Finnish", async () => {
    const { default: Page } = await import("@/app/p/session/page");
    await renderPage(Page());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      fi.participant.session.errorExpiredTitle,
    );
    expect(fi.participant.session.errorExpiredTitle).not.toBe(en.participant.session.errorExpiredTitle);
  });

  it("participant arrival: invalid link in Finnish", async () => {
    api.getLink.mockRejectedValue(new ApiError(404, "not_found", "no"));
    const { default: Page } = await import("@/app/p/[linkToken]/page");
    await renderPage(
      Page({ params: Promise.resolve({ linkToken: "abc" }), searchParams: Promise.resolve({}) }),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(fi.participant.arrival.invalidTitle);
    expect(screen.getByText(fi.participant.arrival.invalidBody)).toBeInTheDocument();
  });

  it("requirements invitation: revoked link in Finnish", async () => {
    api.getInvite.mockResolvedValue({ status: "revoked" });
    const { default: Page } = await import("@/app/p/r/[token]/page");
    await renderPage(Page({ params: Promise.resolve({ token: "tok" }) }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(fi.participant.invite.revokedTitle);
  });

  it("sign-in page: title and button in Finnish", async () => {
    const { default: Page } = await import("@/app/auth/signin/page");
    await renderPage(Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(fi.auth.title)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: fi.auth.sendLink })).toBeInTheDocument();
  });

  it("auth error and verify screens in Finnish", async () => {
    const { default: ErrorPage } = await import("@/app/auth/error/page");
    await renderPage(ErrorPage());
    expect(screen.getByText(fi.auth.error)).toBeInTheDocument();
    request.memo.clear();
    const { default: VerifyPage } = await import("@/app/auth/verify/page");
    await renderPage(VerifyPage());
    expect(screen.getByText(fi.auth.verifyRequest)).toBeInTheDocument();
  });

  it("not-found page in Finnish, with no way to the staff sign-in for a participant", async () => {
    const { default: NotFound } = await import("@/app/not-found");
    await renderPage(NotFound());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(fi.app.notFoundTitle);
    expect(screen.getByText(fi.app.notFoundBody)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("not-found page offers the dashboard only to a signed-in staff member", async () => {
    api.staffToken = "jwt";
    const { default: NotFound } = await import("@/app/not-found");
    await renderPage(NotFound());
    expect(screen.getByRole("link", { name: fi.app.notFoundDashboard })).toHaveAttribute("href", "/admin");
  });

  it("participant not-found says the link is not valid and has no link of its own", async () => {
    const { default: NotFound } = await import("@/app/p/not-found");
    await renderPage(NotFound());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(fi.participant.arrival.invalidTitle);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("an admin list page renders its header in Finnish", async () => {
    const { default: Page } = await import("@/app/admin/users/page");
    await renderPage(Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(fi.admin.users.title);
    expect(fi.admin.users.title).not.toBe(en.admin.users.title);
  });

  it("falls back to English without a cookie", async () => {
    request.cookie = undefined;
    const { default: Page } = await import("@/app/p/session/page");
    await renderPage(Page());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      en.participant.session.errorExpiredTitle,
    );
  });
});

/*
 * The rendering tests above cover the shapes; this keeps the next page from forgetting. A server
 * entry point (page, not-found, loading) must resolve the locale itself, because nothing else is
 * guaranteed to have done so by the time it reads a string.
 */
describe("every server entry point resolves the request locale", () => {
  const appDir = path.resolve(import.meta.dirname, "../src/app");

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  }

  const entryPoints = walk(appDir).filter((f) => /\/(page|not-found|loading)\.tsx$/.test(f));

  it("finds the entry points", () => {
    expect(entryPoints.length).toBeGreaterThan(30);
  });

  it.each(entryPoints.map((f) => [path.relative(appDir, f), f] as const))("%s", (_name, file) => {
    const source = readFileSync(file, "utf8");
    if (/^"use client"/m.test(source)) return;
    // Pages that only redirect read no strings.
    if (!source.includes('from "@/i18n"') && !/\bt\./.test(source)) return;
    // `generateMetadata` awaits it too, which does not help the page body: look at the default export.
    const body = source.slice(source.indexOf("export default"));
    expect(body).toMatch(/await (requestLocale|getStrings)\(\)/);
  });
});
