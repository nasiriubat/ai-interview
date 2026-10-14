import { render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FILTERS, OpportunityFilters } from "@/components/admin/results/OpportunityFilters";

/*
 * Simulation 2026-10-15: the class filter was a fixed 10 rem and read "Solution class: Al". The
 * triggers size to their label (with a floor), so the value is never cut, in Finnish either.
 */
describe("opportunity filters", () => {
  it("lets each select grow to its label instead of a fixed width", () => {
    render(
      <OpportunityFilters
        filters={DEFAULT_FILTERS}
        onChange={vi.fn()}
        shown={15}
        total={15}
        onOpenWeights={vi.fn()}
      />,
    );
    for (const trigger of screen.getAllByRole("combobox")) {
      expect(trigger.className).toMatch(/\bw-auto\b/);
      expect(trigger.className).not.toMatch(/(^|\s)w-(36|40)(\s|$)/);
    }
  });
});
