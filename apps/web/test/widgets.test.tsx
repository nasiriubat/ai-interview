import type { Widget, WidgetResponse } from "@aidp/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WidgetRenderer } from "@/components/widgets";

const options = [
  { key: "email", label: "Email", detail: "Messages in your inbox" },
  { key: "crm", label: "CRM" },
  { key: "sheets", label: "Spreadsheets" },
];

function setup(widget: Widget): {
  onSubmit: ReturnType<typeof vi.fn>;
  user: ReturnType<typeof userEvent.setup>;
} {
  const onSubmit = vi.fn();
  render(<WidgetRenderer widget={widget} onSubmit={onSubmit as (r: WidgetResponse) => void} />);
  return { onSubmit, user: userEvent.setup() };
}

describe("single_choice", () => {
  it("submits the chosen key and the Other text", async () => {
    const { onSubmit, user } = setup({ type: "single_choice", options });
    const submit = screen.getByRole("button", { name: "Send answer" });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "CRM" }));
    await user.type(screen.getByLabelText("Other"), "and Slack");
    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ type: "single_choice", key: "crm", other: "and Slack" });
  });

  it("allows an Other-only answer and expands option details", async () => {
    const { onSubmit, user } = setup({ type: "single_choice", options });
    const toggle = screen.getByRole("button", { name: "More about Email" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Messages in your inbox")).toBeVisible();
    await user.type(screen.getByLabelText("Other"), "Paper");
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onSubmit).toHaveBeenCalledWith({ type: "single_choice", other: "Paper" });
  });
});

describe("multi_choice", () => {
  it("enforces max and submits keys in selection order", async () => {
    const { onSubmit, user } = setup({ type: "multi_choice", options, max: 2 });
    expect(screen.getByText("Choose up to 2")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "CRM" }));
    await user.click(screen.getByRole("checkbox", { name: "Email" }));
    expect(screen.getByRole("checkbox", { name: "Spreadsheets" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onSubmit).toHaveBeenCalledWith({ type: "multi_choice", keys: ["crm", "email"] });
  });
});

describe("scale", () => {
  it("answers with one tap", async () => {
    const { onSubmit, user } = setup({
      type: "scale",
      min: 1,
      max: 5,
      minLabel: "Rarely",
      maxLabel: "Always",
    });
    expect(screen.getByText("Rarely")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "4 of 5" }));
    expect(onSubmit).toHaveBeenCalledWith({ type: "scale", value: 4 });
  });
});

describe("ranking", () => {
  it("reorders with the up and down buttons", async () => {
    const { onSubmit, user } = setup({ type: "ranking", options });
    expect(screen.getByRole("button", { name: "Move up: Email" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move down: Email" }));
    await user.click(screen.getByRole("button", { name: "Move up: Spreadsheets" }));
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onSubmit).toHaveBeenCalledWith({ type: "ranking", keys: ["crm", "sheets", "email"] });
  });
});

describe("yes_no", () => {
  it("submits the value with an optional addition", async () => {
    const { onSubmit, user } = setup({ type: "yes_no", followUpOnYes: "Tell me more" });
    expect(screen.getByText("Tell me more")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Other"), "sometimes");
    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(onSubmit).toHaveBeenCalledWith({ type: "yes_no", value: true, other: "sometimes" });
  });

  it("disables everything when disabled", () => {
    const onSubmit = vi.fn();
    render(<WidgetRenderer widget={{ type: "yes_no" }} disabled onSubmit={onSubmit} />);
    expect(screen.getByRole("button", { name: "No" })).toBeDisabled();
  });
});
