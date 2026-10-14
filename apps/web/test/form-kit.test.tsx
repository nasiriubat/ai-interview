import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TextField } from "@/components/admin/forms";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { CheckboxField, RadioField, SecretField, UnitField } from "@/components/form/controls";
import { Form } from "@/components/form/Form";
import { useForm } from "@/components/form/useForm";
import { ApiError } from "@/lib/api/errors";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/ui/sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
  Toaster: () => null,
}));

const schema = z.object({ name: z.string().min(2), days: z.number().min(1) });

function Demo({
  onSubmit,
}: {
  onSubmit: (v: { name: string; days: number | "" }) => Promise<void>;
}): React.JSX.Element {
  const form = useForm({
    id: "demo",
    initial: { name: "Ward", days: 30 },
    schema,
    labels: { name: "Name", days: "Days" },
    onSubmit,
  });
  return (
    <Form form={form}>
      <TextField {...form.field("name")} label="Name" required />
      <UnitField {...form.field("days")} label="Days" unit="days" />
    </Form>
  );
}

describe("useForm and Form", () => {
  it("starts clean with Save disabled, and says there is nothing unsaved", () => {
    render(<Demo onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("shows an error only after the field was left, not while typing", async () => {
    const user = userEvent.setup();
    render(<Demo onSubmit={vi.fn()} />);
    const name = screen.getByLabelText(/Name/);
    await user.clear(name);
    expect(screen.queryByText(/This field is required|Use at least/)).not.toBeInTheDocument();
    await user.tab();
    expect(await screen.findByText(/Use at least 2 characters|This field is required/)).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
  });

  it("will not submit an invalid form, lists the problem and focuses the field", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<Demo onSubmit={onSubmit} />);
    const name = screen.getByLabelText(/Name/);
    await user.clear(name);
    await user.type(name, "x");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText("1 problem to fix")).toBeInTheDocument();
    await waitFor(() => {
      expect(name).toHaveFocus();
    });
  });

  it("submits valid values once, marks them saved and disables Save again", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<Demo onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText(/Name/), " round");
    expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ name: "Ward round", days: 30 });
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    });
  });

  it("discard puts the saved values back", async () => {
    const user = userEvent.setup();
    render(<Demo onSubmit={vi.fn()} />);
    const name = screen.getByLabelText(/Name/);
    await user.type(name, "zzz");
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(name).toHaveValue("Ward");
  });

  it("puts a server validation error on its field", async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn()
      .mockRejectedValue(
        new ApiError(400, "validation", "bad", [{ path: ["name"], message: "Name is taken." }]),
      );
    render(<Demo onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText(/Name/), "x");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findAllByText("Name is taken.")).not.toHaveLength(0);
  });
});

describe("controls", () => {
  it("a secret is masked until revealed and says one is saved", async () => {
    const user = userEvent.setup();
    render(<SecretField id="k" label="API key" value="abc" isSet onChange={vi.fn()} />);
    const input = screen.getByLabelText("API key");
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByText("A value is saved. Type to replace it.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show value" }));
    expect(input).toHaveAttribute("type", "text");
  });

  it("a unit field announces its unit and returns numbers", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<UnitField id="d" label="Retention" unit="days" value={30} onChange={onChange} />);
    expect(screen.getByLabelText("Retention")).toHaveAccessibleDescription("days");
    await user.type(screen.getByLabelText("Retention"), "5");
    expect(onChange).toHaveBeenLastCalledWith(305);
  });

  it("a radio field is a labelled group with a hint per option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RadioField
        id="r"
        label="Role"
        value="a"
        options={[
          { value: "a", label: "Admin", hint: "Everything." },
          { value: "b", label: "Member" },
        ]}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("group", { name: "Role" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Admin" })).toHaveAccessibleDescription("Everything.");
    await user.click(screen.getByRole("radio", { name: "Member" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("a checkbox field toggles and carries its error", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CheckboxField id="c" label="Agree" checked={false} error="Required." onChange={onChange} />);
    await user.click(screen.getByRole("checkbox", { name: "Agree" }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("alert")).toHaveTextContent("Required.");
  });
});

describe("typed confirmation", () => {
  it("keeps the confirm button disabled until the phrase is typed exactly", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete the organization?"
        description={<p>Everything goes.</p>}
        confirmLabel="Delete organization"
        confirmPhrase="Acme Care"
        onConfirm={onConfirm}
      />,
    );
    const confirm = screen.getByRole("button", { name: "Delete organization" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText("Type Acme Care to confirm"), "acme care");
    expect(confirm).toBeDisabled();
    await user.clear(screen.getByLabelText("Type Acme Care to confirm"));
    await user.type(screen.getByLabelText("Type Acme Care to confirm"), "Acme Care");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalled();
  });
});
