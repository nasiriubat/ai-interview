import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Trash2Icon } from "lucide-react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { IconButton, RowActions } from "@/components/admin/IconButton";

describe("IconButton", () => {
  it("renders a button whose accessible name is the action", async () => {
    const onClick = vi.fn();
    render(
      <RowActions>
        <IconButton label="Delete provider: OpenAI" icon={<Trash2Icon />} onClick={onClick} />
      </RowActions>,
    );
    const button = screen.getByRole("button", { name: "Delete provider: OpenAI" });
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders a link when given an href", () => {
    render(<IconButton label="View" icon={<Trash2Icon />} href="/admin/campaigns/c1" />);
    expect(screen.getByRole("link", { name: "View" })).toHaveAttribute("href", "/admin/campaigns/c1");
  });

  it("shows the tooltip on focus", async () => {
    const user = userEvent.setup();
    render(<IconButton label="Send a reminder" icon={<Trash2Icon />} onClick={vi.fn()} />);
    await user.tab();
    expect(await screen.findAllByText("Send a reminder")).not.toHaveLength(0);
  });

  it("can be disabled", () => {
    render(<IconButton label="Revoke" icon={<Trash2Icon />} disabled onClick={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Revoke" })).toBeDisabled();
  });

  // The regression this guards: `icon` used to take the component type, and a server page passing
  // `icon={Trash2Icon}` crashed the route with React error #441, because a function cannot cross
  // the server/client boundary. Taking a rendered element means there is no function to pass. The
  // type rejects the old form at compile time; this asserts the glyph still reaches the button and
  // stays out of the accessible name, which the button itself supplies.
  it("renders the icon element and hides it from assistive technology", () => {
    const { container } = render(
      <IconButton label="Revoke" icon={<Trash2Icon data-testid="glyph" />} onClick={vi.fn()} />,
    );
    expect(screen.getByTestId("glyph")).toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')).toContainElement(screen.getByTestId("glyph"));
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
  });
});
