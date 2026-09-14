import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";

const options: ComboboxOption[] = [
  { value: "claude-opus-4", label: "Claude Opus 4", detail: "anthropic" },
  { value: "claude-sonnet-4", label: "Claude Sonnet 4", detail: "anthropic" },
  { value: "gpt-5", label: "GPT-5", detail: "openai" },
];

const labels = {
  placeholder: "Choose a model…",
  search: "Search…",
  empty: "Nothing matches your search.",
  loading: "Loading…",
  useCustom: (v: string): string => `Use “${v}”`,
};

function Harness({
  allowCustom,
  loading,
  onChange,
}: {
  allowCustom?: boolean;
  loading?: boolean;
  onChange: (v: string) => void;
}): React.JSX.Element {
  const [value, setValue] = React.useState("");
  return (
    <Combobox
      id="model"
      value={value}
      options={options}
      labels={labels}
      allowCustom={allowCustom}
      loading={loading}
      aria-label="Model"
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

async function open(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Model" }));
  return await screen.findByRole("listbox");
}

describe("Combobox", () => {
  it("shows the placeholder, opens on click and lists every option", async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Model" });
    expect(trigger).toHaveTextContent("Choose a model…");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await open(user);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("filters as you type and shows the empty state when nothing matches", async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);
    await open(user);

    await user.type(screen.getByPlaceholderText("Search…"), "sonnet");
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(1);
    });
    expect(screen.getByRole("option")).toHaveTextContent("Claude Sonnet 4");

    await user.clear(screen.getByPlaceholderText("Search…"));
    await user.type(screen.getByPlaceholderText("Search…"), "zzz");
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Nothing matches your search.")).toBeInTheDocument();
  });

  it("matches on the detail line as well as the label", async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);
    await open(user);
    await user.type(screen.getByPlaceholderText("Search…"), "openai");
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(1);
    });
    expect(screen.getByRole("option")).toHaveTextContent("GPT-5");
  });

  it("moves the active option with the arrow keys and selects it with enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const list = await open(user);
    const input = screen.getByPlaceholderText("Search…");

    expect(input).toHaveAttribute("aria-activedescendant", `${list.id}-0`);
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", `${list.id}-1`);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(input).toHaveAttribute("aria-activedescendant", `${list.id}-2`);
    await user.keyboard("{Home}");
    expect(input).toHaveAttribute("aria-activedescendant", `${list.id}-0`);
    await user.keyboard("{End}");
    expect(input).toHaveAttribute("aria-activedescendant", `${list.id}-2`);

    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("gpt-5");
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("GPT-5");
  });

  it("closes on escape without choosing anything", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await open(user);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("selects an option with the mouse", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await open(user);
    await user.click(screen.getByRole("option", { name: /Claude Sonnet 4/ }));
    expect(onChange).toHaveBeenCalledWith("claude-sonnet-4");
  });

  it("offers the typed text as a value when allowCustom is set", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness allowCustom onChange={onChange} />);
    await open(user);
    await user.type(screen.getByPlaceholderText("Search…"), "my-private-model");
    const custom = await screen.findByRole("option", { name: /Use “my-private-model”/ });
    await user.click(custom);
    expect(onChange).toHaveBeenCalledWith("my-private-model");
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("my-private-model");
  });

  it("does not offer a custom row without allowCustom", async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);
    await open(user);
    await user.type(screen.getByPlaceholderText("Search…"), "my-private-model");
    await waitFor(() => {
      expect(screen.getByText("Nothing matches your search.")).toBeInTheDocument();
    });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("shows the loading state instead of the list", async () => {
    const user = userEvent.setup();
    render(<Harness loading onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
