import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportsPanel, warningText, type ExportItem } from "@/components/admin/ExportsPanel";
import { setClientLocale } from "@/i18n";
import { filenameFrom } from "@/lib/exports/download";

/*
 * The export panel (D-211): a download that the server composes has three states, and the person
 * has to be told which one it is, and what the file left out.
 */

const pdf: ExportItem = {
  id: "pdf",
  label: "Download PDF",
  what: "PDF",
  url: "/api/staff/analyses/a1/report.pdf",
  fallbackName: "report.pdf",
};
const md: ExportItem = {
  id: "md",
  label: "Download full report (Markdown)",
  what: "Markdown",
  fallbackName: "report.md",
  text: { content: "# Report", filename: "ward-report-v1.md", mime: "text/markdown" },
};

const originalFetch = globalThis.fetch;
let saved: { name: string; size: number }[] = [];

beforeEach(() => {
  saved = [];
  URL.createObjectURL = vi.fn((blob: Blob) => {
    saved.push({ name: "", size: blob.size });
    return "blob:test";
  });
  URL.revokeObjectURL = vi.fn();
  // jsdom cannot navigate to a blob; the click is what the browser would turn into a save.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    const last = saved.at(-1);
    if (last) last.name = this.download;
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  setClientLocale("en");
});

const reply = (body: BodyInit, init: ResponseInit) => Promise.resolve(new Response(body, init));

describe("ExportsPanel", () => {
  it("prepares a PDF through the proxy, saves it under the server's name and says how long it is", async () => {
    let release: (r: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    globalThis.fetch = fetchMock;
    const user = userEvent.setup();
    render(<ExportsPanel items={[pdf, md]} />);

    await user.click(screen.getByRole("button", { name: "Download PDF" }));
    // while it is being composed: announced, and nothing else can be started
    expect(screen.getByRole("status")).toHaveTextContent("Preparing PDF…");
    expect(screen.getByRole("button", { name: /Download full report/ })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/staff/analyses/a1/report.pdf",
      expect.objectContaining({ credentials: "same-origin" }),
    );

    release(
      new Response("%PDF-1.3 fake", {
        status: 200,
        headers: {
          "content-disposition": 'attachment; filename="ward-processes-report-v2.pdf"',
          "x-export-pages": "7",
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("ward-processes-report-v2.pdf was downloaded."),
    );
    expect(screen.getByRole("status")).toHaveTextContent("7 pages");
    expect(saved).toEqual([{ name: "ward-processes-report-v2.pdf", size: 13 }]);
    // and it can be started again
    expect(screen.getByRole("button", { name: "Download PDF" })).toBeEnabled();
  });

  it("says in words what the server left out of the file", async () => {
    globalThis.fetch = vi.fn(() =>
      reply("%PDF", {
        status: 200,
        headers: {
          "content-disposition": 'attachment; filename="x.pdf"',
          "x-export-warnings": "diagram_unrendered:2,diagram_syntax:3,truncated:blocks",
        },
      }),
    );
    const user = userEvent.setup();
    render(<ExportsPanel items={[pdf]} />);
    await user.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(await screen.findByText("The file was made, with these notes:")).toBeInTheDocument();
    expect(screen.getByText(/Diagram 2 could not be drawn/)).toBeInTheDocument();
    expect(screen.getByText(/Diagram 3 has a syntax error/)).toBeInTheDocument();
    expect(screen.getByText(/end of it is left out/)).toBeInTheDocument();
  });

  it("explains a busy server and a document that is too long, and offers a retry", async () => {
    const answers = [
      { status: 429, code: "rate_limited", message: "Another document is being prepared." },
      { status: 413, code: "too_large", message: "The document is longer than 150 pages" },
    ];
    let call = 0;
    globalThis.fetch = vi.fn(() => {
      const a = answers[Math.min(call++, answers.length - 1)];
      return reply(JSON.stringify({ error: { code: a?.code, message: a?.message } }), {
        status: a?.status ?? 500,
      });
    });
    const user = userEvent.setup();
    render(<ExportsPanel items={[pdf]} />);
    await user.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(await screen.findByText(/Another document is being prepared right now/)).toBeInTheDocument();
    expect(saved).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/too long to export as a PDF/)).toBeInTheDocument();
  });

  it("shows the server's own message for a failure it has no wording for", async () => {
    globalThis.fetch = vi.fn(() =>
      reply(
        JSON.stringify({ error: { code: "forbidden", message: "Preliminary results are not visible" } }),
        {
          status: 403,
        },
      ),
    );
    const user = userEvent.setup();
    render(<ExportsPanel items={[pdf]} />);
    await user.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(await screen.findByText(/Preliminary results are not visible/)).toBeInTheDocument();
  });

  it("saves text the page already holds without a request", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const user = userEvent.setup();
    render(<ExportsPanel items={[pdf, md]} />);
    await user.click(screen.getByRole("button", { name: /Download full report/ }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved).toEqual([{ name: "ward-report-v1.md", size: 8 }]);
    expect(screen.getByRole("status")).toHaveTextContent("ward-report-v1.md was downloaded.");
  });

  it("carries extra actions beside the downloads", () => {
    render(
      <ExportsPanel items={[pdf]} heading="Downloads">
        <button type="button">Push to GitHub</button>
      </ExportsPanel>,
    );
    expect(screen.getByRole("heading", { name: "Downloads" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Push to GitHub" })).toBeInTheDocument();
  });

  it("speaks Finnish, in the second person singular", async () => {
    setClientLocale("fi");
    globalThis.fetch = vi.fn(() =>
      reply("%PDF", {
        status: 200,
        headers: {
          "content-disposition": 'attachment; filename="raportti.pdf"',
          "x-export-warnings": "diagram_unrendered:1",
        },
      }),
    );
    const user = userEvent.setup();
    render(<ExportsPanel items={[{ ...pdf, label: "Lataa PDF" }]} />);
    await user.click(screen.getByRole("button", { name: "Lataa PDF" }));
    expect(await screen.findByText("Tiedosto raportti.pdf ladattiin.")).toBeInTheDocument();
    expect(screen.getByText(/Kaaviota 1 ei voitu piirtää/)).toBeInTheDocument();
    expect(warningText("diagram_syntax:4")).toContain("Kaaviossa 4");
  });
});

describe("filenameFrom", () => {
  it("reads a quoted or bare file name and falls back otherwise", () => {
    expect(filenameFrom('attachment; filename="spec-v2.pdf"', "x")).toBe("spec-v2.pdf");
    expect(filenameFrom("attachment; filename=spec-v2.pdf", "x")).toBe("spec-v2.pdf");
    expect(filenameFrom(null, "fallback.pdf")).toBe("fallback.pdf");
  });

  it("will not take a path out of a header", () => {
    expect(filenameFrom('attachment; filename="../../etc/passwd"', "safe.pdf")).toBe("safe.pdf");
  });
});

describe("warningText", () => {
  it("has words for every code the server can send, and never shows a bare code for a known one", () => {
    for (const code of [
      "diagram_unrendered:1",
      "diagram_syntax:2",
      "diagram_over_limit",
      "diagram_too_large",
      "truncated:characters",
      "truncated:blocks",
      "table_columns_truncated",
      "table_rows_truncated",
    ]) {
      expect(warningText(code)).not.toMatch(/^Note:/);
    }
    expect(warningText("something_new")).toBe("Note: something_new");
  });
});
