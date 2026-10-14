import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CategoryForm } from "@/components/admin/settings/CategoryForm";
import type { SettingsCatalogEntry } from "@/lib/api/schemas";

const put = vi.fn();
const emailTest = vi.fn();

vi.mock("@/lib/api/browser", () => ({
  staffClient: {
    settings: {
      put: (...args: unknown[]): unknown => put(...args),
      emailTest: (...args: unknown[]): unknown => emailTest(...args),
    },
  },
  participantClient: {},
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

const emailEntries: SettingsCatalogEntry[] = [
  {
    key: "email.smtpUrl",
    category: "email",
    description: "SMTP connection string",
    default: "",
    scopes: ["platform", "tenant"],
    secret: true,
  },
  {
    key: "email.from",
    category: "email",
    description: "Envelope sender",
    default: "noreply@example.com",
    scopes: ["platform", "tenant"],
    secret: false,
  },
  {
    key: "email.replyTo",
    category: "email",
    description: "Optional reply-to",
    default: "",
    scopes: ["platform", "tenant"],
    secret: false,
  },
];

function renderForm(overrides: Partial<React.ComponentProps<typeof CategoryForm>> = {}): void {
  render(
    <CategoryForm
      category="email"
      title="Email"
      entries={emailEntries}
      values={{}}
      effective={{}}
      secrets={{}}
      sources={{}}
      scope="tenant"
      scopeId={undefined}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  put.mockReset();
  put.mockResolvedValue(undefined);
  emailTest.mockReset();
});

describe("CategoryForm", () => {
  it("sends only this category's keys, with the sentinel for an untouched secret", async () => {
    const user = userEvent.setup();
    renderForm({
      values: { "email.from": "hello@acme.fi", "engine.maxTurns": 40 },
      effective: { "email.from": "hello@acme.fi", "email.replyTo": "inherited@acme.fi" },
      secrets: { "email.smtpUrl": true },
    });

    await user.click(screen.getByRole("button", { name: "Save this category" }));
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1);
    });
    const [query, payload] = put.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(query).toEqual({ scope: "tenant" });
    expect(payload).toEqual({
      "email.smtpUrl": "__unchanged__",
      "email.from": "hello@acme.fi",
    });
    expect(payload).not.toHaveProperty("engine.maxTurns");
    // An inherited, never-overridden key is not sent at all.
    expect(payload).not.toHaveProperty("email.replyTo");
  });

  it("sends a typed secret and never renders its stored value", async () => {
    const user = userEvent.setup();
    renderForm({ secrets: { "email.smtpUrl": true } });

    const secret = screen.getByLabelText(/SMTP connection/i);
    expect(secret).toHaveAttribute("type", "password");
    expect(secret).toHaveValue("");
    expect(screen.getByText("Set")).toBeInTheDocument();

    await user.type(secret, "smtp://user:pass@host:587");
    await user.click(screen.getByRole("button", { name: "Save this category" }));
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1);
    });
    const [, payload] = put.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload["email.smtpUrl"]).toBe("smtp://user:pass@host:587");
  });

  it("clears a secret with null and flips the badge", async () => {
    const user = userEvent.setup();
    renderForm({ secrets: { "email.smtpUrl": true } });

    await user.click(screen.getByRole("button", { name: "Clear the stored value" }));
    expect(screen.getByText("Not set")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save this category" }));
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1);
    });
    const [, payload] = put.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload["email.smtpUrl"]).toBeNull();
  });

  it("resets an override with an explicit null and marks the key inherited", async () => {
    const user = userEvent.setup();
    renderForm({
      values: { "email.from": "hello@acme.fi" },
      effective: { "email.from": "hello@acme.fi" },
    });

    expect(screen.getAllByText("Set here")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Reset to the inherited value" }));
    await user.click(screen.getByRole("button", { name: "Save this category" }));
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1);
    });
    const [, payload] = put.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload["email.from"]).toBeNull();
  });

  it("shows the inherited value and where it came from", () => {
    renderForm({
      effective: { "email.from": "platform@aidp.dev" },
      sources: { "email.from": "platform" },
    });
    expect(screen.getByLabelText(/^Sender address/i)).toHaveValue("platform@aidp.dev");
    expect(screen.getByText("Inherited from platform")).toBeInTheDocument();
  });

  it("shows an unset sender empty with the install address as its placeholder, not example.com", () => {
    const smtp = { set: null, effective: "env" as const, envConfigured: true };
    renderForm({ scope: "platform", smtp, effective: { "email.from": "noreply@example.com" } });
    const sender = screen.getByRole("textbox", { name: /Sender address/ });
    expect(sender).toHaveValue("");
    expect(sender).toHaveAttribute("placeholder", "The address set at install");
  });

  it("shows a sender someone set", () => {
    const smtp = { set: null, effective: "env" as const, envConfigured: true };
    renderForm({
      smtp,
      values: { "email.from": "hello@acme.fi" },
      effective: { "email.from": "hello@acme.fi" },
    });
    expect(screen.getByRole("textbox", { name: /Sender address/ })).toHaveValue("hello@acme.fi");
  });

  it("sends a test email and reports the scope that was used", async () => {
    const user = userEvent.setup();
    emailTest.mockResolvedValue({ ok: true, usedScope: "tenant" });
    renderForm();

    await user.click(screen.getByRole("button", { name: "Send test email" }));
    await waitFor(() => {
      expect(emailTest).toHaveBeenCalledWith({ scope: "tenant" });
    });
    expect(
      await screen.findByText(/Test email sent using the organization configuration/),
    ).toBeInTheDocument();
  });

  it("reports a failed test email", async () => {
    const user = userEvent.setup();
    emailTest.mockResolvedValue({ ok: false, usedScope: "env", error: "connection refused" });
    renderForm();

    await user.click(screen.getByRole("button", { name: "Send test email" }));
    expect(await screen.findByText(/Test email failed: connection refused/)).toBeInTheDocument();
  });
});
