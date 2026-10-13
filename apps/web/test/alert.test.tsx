import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

describe("Alert role", () => {
  it("interrupts by default, because most alerts report a failure", () => {
    render(
      <Alert variant="destructive">
        <AlertDescription>The save failed.</AlertDescription>
      </Alert>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The save failed.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("is a polite status when the content is not urgent", () => {
    render(
      <Alert variant="warning" role="status">
        <AlertDescription>Results are preliminary.</AlertDescription>
      </Alert>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Results are preliminary.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Button busy spinner under reduced motion", () => {
  it("only spins when motion is allowed, and stays visible when it is not", () => {
    render(<Button loading>Save</Button>);
    const spinner = screen.getByRole("button", { name: "Save" }).querySelector(".spinner");
    expect(spinner).not.toBeNull();
    expect(spinner?.getAttribute("class")).toContain("motion-safe:animate-spin");
    expect(spinner?.getAttribute("class")).not.toMatch(/(^|\s)animate-spin/);
    expect(spinner?.getAttribute("class")).toContain("motion-reduce:opacity-60");
  });
});
