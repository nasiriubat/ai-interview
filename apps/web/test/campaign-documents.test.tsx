import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CampaignDocumentsPanel } from "@/components/admin/campaigns/CampaignDocumentsPanel";
import { CampaignDocumentListSchema } from "@/lib/api/schemas";

const staff = vi.hoisted(() => ({
  campaigns: {
    documents: {
      list: vi.fn(),
      upload: vi.fn(),
      remove: vi.fn(() => Promise.resolve()),
    },
  },
}));
vi.mock("@/lib/api/browser", () => ({ staffClient: staff, participantClient: {} }));

const initial = CampaignDocumentListSchema.parse({
  documents: [
    {
      id: "d1",
      filename: "org-chart.pdf",
      sizeBytes: 2048,
      status: "ready",
      summary: "Three wards, one charge nurse per shift.",
    },
    { id: "d2", filename: "scan.jpg", kind: "image", sizeBytes: 4096, status: "failed", error: "no_text" },
  ],
  uploads: { maxSizeMb: 20, allowedTypes: ["application/pdf"], maxDocuments: 10 },
});

describe("campaign background documents (D-491)", () => {
  it("shows each document's state and what was read, and says how they are used", () => {
    render(<CampaignDocumentsPanel campaignId="c1" initial={initial} canEdit />);
    expect(screen.getByRole("heading", { name: "Background documents" })).toBeInTheDocument();
    expect(screen.getByText("Three wards, one charge nurse per shift.")).toBeInTheDocument();
    expect(screen.getByText(/No text found in this file/)).toBeInTheDocument();
    expect(screen.getByText(/context, not evidence/)).toBeInTheDocument();
  });

  it("lets an administrator remove one", async () => {
    const user = userEvent.setup();
    render(<CampaignDocumentsPanel campaignId="c1" initial={initial} canEdit />);
    await user.click(screen.getByRole("button", { name: "Remove org-chart.pdf" }));
    expect(staff.campaigns.documents.remove).toHaveBeenCalledWith("c1", "d1");
    await waitFor(() => {
      expect(screen.queryByText("org-chart.pdf")).not.toBeInTheDocument();
    });
  });

  it("is read-only for a member", () => {
    render(<CampaignDocumentsPanel campaignId="c1" initial={initial} canEdit={false} />);
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Add background documents")).not.toBeInTheDocument();
  });
});
