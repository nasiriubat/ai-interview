import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageBubble } from "@/components/participant/MessageList";
import { Label } from "@/components/ui/label";
import { WidgetRenderer } from "@/components/widgets";
import { renderInlineMarkup } from "@/lib/inline-markup";

const options = [
  { key: "a", label: "Admin" },
  { key: "s", label: "Staff" },
];

describe("interviewer emphasis", () => {
  it("renders **bold** and *italic* as elements, never as asterisks or HTML", () => {
    render(
      <MessageBubble
        message={{ role: "assistant", content: "For the **staff** role, *roughly* <b>how</b> many?" }}
      />,
    );
    expect(screen.getByText("staff").tagName).toBe("STRONG");
    expect(screen.getByText("roughly").tagName).toBe("EM");
    expect(document.body.textContent).not.toContain("**");
    // Markup in the text stays text.
    expect(document.querySelector("b")).toBeNull();
  });

  it("leaves a participant's own words exactly as typed", () => {
    render(<MessageBubble message={{ role: "user", content: "use **two** stars" }} />);
    expect(screen.getByText("use **two** stars")).toBeInTheDocument();
  });

  it("does not treat lone or list asterisks as emphasis", () => {
    expect(renderInlineMarkup("5 * 3 and * a list")).toEqual(["5 * 3 and * a list"]);
  });
});

describe("the Other choice (D-482)", () => {
  it("is the last option of a single choice and opens a field that sends the written answer", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<WidgetRenderer widget={{ type: "single_choice", options }} other={false} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("radio", { name: "Other" }));
    const field = screen.getByRole("textbox", { name: "Other" });
    expect(field).toHaveFocus();
    expect(screen.getByRole("button", { name: "Send answer" })).toBeDisabled();
    await user.type(field, "Night nurse");
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onSubmit).toHaveBeenCalledWith({ type: "single_choice", other: "Night nurse" });
  });

  it("can be ticked with other options in a multi choice", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<WidgetRenderer widget={{ type: "multi_choice", options }} other={false} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("checkbox", { name: "Staff" }));
    await user.click(screen.getByRole("checkbox", { name: "Other" }));
    await user.type(screen.getByRole("textbox", { name: "Other" }), "Volunteers");
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onSubmit).toHaveBeenCalledWith({ type: "multi_choice", keys: ["s"], other: "Volunteers" });
  });
});

describe("required labels", () => {
  it("paint a red asterisk that a screen reader does not read", () => {
    render(
      <>
        <Label htmlFor="e" required>
          Email
        </Label>
        <input id="e" required />
      </>,
    );
    const star = screen.getByText("*");
    expect(star).toHaveAttribute("aria-hidden", "true");
    expect(star).toHaveClass("text-destructive");
    expect(screen.getByRole("textbox", { name: "Email" })).toBeRequired();
  });
});

describe("why a file could not be read (D-489)", () => {
  it("is a translated sentence for every code, and never the server's raw text", async () => {
    const { attachmentFailure } = await import("@/components/participant/AttachmentList");
    expect(attachmentFailure("pdf_pages")).toMatch(/too large or complex/);
    expect(attachmentFailure("zip_encrypted")).toMatch(/damaged or protected/);
    expect(attachmentFailure("ingest_failed")).toMatch(/attach it again/);
    expect(attachmentFailure("Error: connect ECONNREFUSED 10.0.0.4:443")).toBe("Could not read this file");
  });
});
