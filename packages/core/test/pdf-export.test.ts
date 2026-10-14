import { readPdf } from "@aidp/testing";
import { describe, expect, it } from "vitest";
import {
  FakeKroki,
  HttpKroki,
  KrokiSyntaxError,
  KrokiUnavailableError,
  PdfTooLargeError,
  renderPdf,
  TINY_PNG,
  type PdfBrand,
  type PdfInput,
} from "../src/exports/index.js";

const brand: PdfBrand = {
  productName: "Acme Discovery",
  color: "#7a1f4e",
  footerText: "Confidential: Acme Oy",
  pageSize: "A4",
  cover: true,
};

const MARKDOWN = [
  "# Discovery report: Ward processes",
  "",
  "Generated 2026-10-14.",
  "",
  "## Executive summary",
  "",
  "Nurses re-key the same **vitals** twice. See _the appendix_ and `ward_chart`.",
  "",
  "## Opportunities",
  "",
  "| Rank | Opportunity | Class |",
  "| --- | --- | --- |",
  "| 1 | Single-entry charting | Software |",
  "| 2 | Päivystyksen vuoronvaihto | Process |",
  "",
  "- First point",
  "  - Nested point",
  "- Second point",
  "",
  "1. Step one",
  "2. Step two",
  "",
  "> A participant said: it takes forever.",
  "",
  "### Process map",
  "",
  "```mermaid",
  "flowchart LR",
  '  a["Receive"] --> b["Key in"]',
  "```",
  "",
  "```ts",
  "const total = a + b;",
  "```",
  "",
  "## Next steps",
  "",
  "Hyvää päivää: äö ÄÖ å.",
].join("\n");

const base = (over: Partial<PdfInput> = {}): PdfInput => ({
  title: "Discovery report: Ward processes",
  markdown: MARKDOWN,
  language: "en",
  versionLabel: "Report v3",
  date: new Date("2026-10-14T10:00:00Z"),
  brand,
  kroki: new FakeKroki(),
  ...over,
});

describe("renderPdf: what a reader of the document sees", () => {
  it("has a cover, a table of contents, a header and footer on every page, and the body", async () => {
    const r = await renderPdf(base());
    expect(r.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const pdf = await readPdf(r.bytes);
    expect(pdf.pages.length).toBe(r.pages);
    expect(pdf.title).toBe("Discovery report: Ward processes");
    expect(pdf.author).toBe("Acme Discovery");

    const cover = pdf.pages[0] ?? "";
    expect(cover).toContain("Acme Discovery");
    expect(cover).toContain("Discovery report: Ward processes");
    expect(cover).toContain("Report v3");
    expect(cover).toContain("Generated 2026-10-14");
    // no running header or footer on the cover
    expect(cover).not.toContain("Confidential: Acme Oy");

    const body = pdf.pages.slice(1).join("\n");
    expect(body).toContain("Contents");
    for (const h of ["Executive summary", "Opportunities", "Next steps"]) expect(body).toContain(h);
    expect(body).toContain("Single-entry charting");
    expect(body).toContain("Päivystyksen vuoronvaihto");
    expect(body).toContain("Nested point");
    expect(body).toContain("Step two");
    expect(body).toContain("A participant said");
    expect(body).toContain("const total = a + b;");
    expect(body).toContain("Hyvää päivää: äö ÄÖ å.");
    // footers: product, title, version, page x of y, and the configured footer text
    expect(body).toContain("Acme Discovery · Discovery report: Ward processes · Report v3");
    expect(body).toContain(`Page 2 of ${r.pages}`);
    expect(body).toContain("Confidential: Acme Oy");
    // headers carry the date
    expect(body).toContain("2026-10-14");
  });

  it("draws a Mermaid fence as an image, through the renderer, with the export theme in front", async () => {
    const kroki = new FakeKroki();
    const r = await renderPdf(base({ kroki }));
    expect(r.warnings).toEqual([]);
    expect(r.diagrams).toEqual({ total: 1, rendered: 1 });
    expect(kroki.calls).toHaveLength(1);
    expect(kroki.calls[0]?.format).toBe("png");
    expect(kroki.calls[0]?.source).toMatch(/^%%\{init: .*"theme":"neutral"/);
    expect(kroki.calls[0]?.source).toContain('a["Receive"] --> b["Key in"]');
    const pdf = await readPdf(r.bytes);
    expect(pdf.imagesPerPage.reduce((a, b) => a + b, 0)).toBe(1);
    // the source is not also printed under the picture
    expect(pdf.text).not.toContain('a["Receive"]');
  });

  it("degrades to the diagram's source with a note when the renderer is unavailable", async () => {
    const kroki = new FakeKroki();
    kroki.failWith = "unavailable";
    const r = await renderPdf(base({ kroki }));
    expect(r.warnings).toEqual(["diagram_unrendered:1"]);
    expect(r.diagrams).toEqual({ total: 1, rendered: 0 });
    const pdf = await readPdf(r.bytes);
    expect(pdf.text).toContain("This diagram could not be drawn; its source is shown instead.");
    expect(pdf.text).toContain("flowchart LR");
    expect(pdf.text).toContain("Key in");
    expect(pdf.imagesPerPage.reduce((a, b) => a + b, 0)).toBe(0);
    // and the rest of the document is all there
    expect(pdf.text).toContain("Next steps");
  });

  it("says a diagram has an error when the renderer rejects its syntax", async () => {
    const kroki = new FakeKroki();
    kroki.failWith = "syntax";
    const r = await renderPdf(base({ kroki }));
    expect(r.warnings).toEqual(["diagram_syntax:1"]);
    const pdf = await readPdf(r.bytes);
    expect(pdf.text).toContain("This diagram has an error and could not be drawn");
    expect(pdf.text).toContain("flowchart LR");
  });

  it("shows every diagram as source when no renderer is configured", async () => {
    const r = await renderPdf(base({ kroki: null }));
    expect(r.warnings).toEqual(["diagram_unrendered:1"]);
    expect((await readPdf(r.bytes)).text).toContain("flowchart LR");
  });

  it("stops asking once the renderer is down, so a dead service costs one timeout, not N", async () => {
    const kroki = new FakeKroki();
    kroki.failWith = "unavailable";
    const fences = Array.from({ length: 6 }, (_, i) => `\`\`\`mermaid\nflowchart LR\n  A${i}-->B\n\`\`\``);
    const r = await renderPdf(
      base({
        kroki,
        markdown: `# T\n\n## S\n\n${fences.join("\n\n")}`,
        limits: { diagramConcurrency: 1 },
      }),
    );
    expect(kroki.calls).toHaveLength(1);
    expect(r.warnings.filter((w) => w.startsWith("diagram_unrendered"))).toHaveLength(6);
  });

  it("renders the diagrams it can when only one is invalid", async () => {
    const kroki = new FakeKroki();
    kroki.rejectContaining = "BROKEN";
    const md = [
      "# T",
      "## S",
      "```mermaid\nflowchart LR\n  good-->ok\n```",
      "```mermaid\nflowchart LR\n  BROKEN-->x\n```",
    ].join("\n\n");
    const r = await renderPdf(base({ kroki, markdown: md, limits: { diagramConcurrency: 1 } }));
    expect(r.diagrams).toEqual({ total: 2, rendered: 1 });
    expect(r.warnings).toEqual(["diagram_syntax:2"]);
  });

  it("skips diagrams past the time budget instead of making the request wait", async () => {
    const kroki = new FakeKroki();
    kroki.delayMs = 30;
    const fences = Array.from({ length: 5 }, (_, i) => `\`\`\`mermaid\nflowchart LR\n  N${i}-->B\n\`\`\``);
    const r = await renderPdf(
      base({
        kroki,
        markdown: `# T\n\n## S\n\n${fences.join("\n\n")}`,
        limits: { diagramConcurrency: 1, diagramBudgetMs: 50 },
      }),
    );
    expect(r.diagrams.rendered).toBeGreaterThan(0);
    expect(r.diagrams.rendered).toBeLessThan(5);
    expect(r.warnings.some((w) => w.startsWith("diagram_unrendered"))).toBe(true);
  });

  it("uses Finnish labels for a Finnish document", async () => {
    const r = await renderPdf(base({ language: "fi", kroki: null }));
    const pdf = await readPdf(r.bytes);
    expect(pdf.text).toContain("Sisällys");
    expect(pdf.text).toContain(`Sivu 2 / ${r.pages}`);
    expect(pdf.text).toContain("Luotu 2026-10-14");
    expect(pdf.text).toContain("Kaaviota ei voitu piirtää");
  });

  it("starts with the title instead of a cover page when the cover is off", async () => {
    const r = await renderPdf(base({ brand: { ...brand, cover: false } }));
    const pdf = await readPdf(r.bytes);
    expect(pdf.pages[0]).toContain("Discovery report: Ward processes");
    expect(pdf.pages[0]).toContain("Executive summary");
    expect(pdf.pages[0]).toContain("Confidential: Acme Oy");
  });

  it("survives a malformed accent colour and unusual page size input", async () => {
    const r = await renderPdf(base({ brand: { ...brand, color: "red; background:url(x)" } }));
    expect(r.pages).toBeGreaterThan(1);
    const letter = await renderPdf(base({ brand: { ...brand, pageSize: "Letter" } }));
    expect(letter.bytes.toString("latin1")).toContain("/MediaBox [0 0 612 792]");
    const a4 = await renderPdf(base());
    expect(a4.bytes.toString("latin1")).toMatch(/\/MediaBox \[0 0 595\.28 841\.89\]/);
  });
});

describe("renderPdf: hostile content", () => {
  const render = async (markdown: string, over: Partial<PdfInput> = {}) => {
    const r = await renderPdf(base({ markdown, kroki: null, ...over }));
    return { r, pdf: await readPdf(r.bytes) };
  };

  it("prints HTML as text and never interprets it", async () => {
    const { pdf } = await render(
      "# T\n\n## S\n\n<script>alert(1)</script> <img src=x onerror=1>\n\n<div>hi</div>",
    );
    expect(pdf.text).toContain("<script>alert(1)</script>");
  });

  it("does not fetch an image: the alt text stays, and the network guard would have thrown", async () => {
    const { pdf } = await render("# T\n\n## S\n\n![the chart](https://evil.example/pixel.png?u=1)\n\nafter");
    expect(pdf.text).toContain("[the chart]");
    expect(pdf.text).toContain("after");
    expect(pdf.imagesPerPage.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("shows a link's address and keeps no clickable annotation", async () => {
    const { r, pdf } = await render(
      "# T\n\n## S\n\n[click](https://example.com/a) and [bad](javascript:alert(1))",
    );
    expect(pdf.text).toContain("click (https://example.com/a)");
    // a script URL is not a link at all, so it stays what it was written as: text
    expect(pdf.text).toContain("[bad](javascript:alert(1))");
    expect(r.bytes.toString("latin1")).not.toContain("/URI");
  });

  it("removes invisible and direction-overriding characters", async () => {
    const { pdf } = await render("# T\n\n## S\n\nadmin‮txt.exe and a​b\u0000c");
    expect(pdf.text).toContain("admintxt.exe and abc");
  });

  it("lays out an unbroken 5000-character word without failing", async () => {
    const { r } = await render(`# T\n\n## S\n\n${"W".repeat(5000)}`);
    expect(r.pages).toBeGreaterThan(1);
  });

  it("caps the input and says so", async () => {
    const { r } = await render(`# T\n\n## S\n\n${"word ".repeat(2_000)}`, { limits: { maxChars: 3_000 } });
    expect(r.warnings).toContain("truncated:characters");
  });

  it("caps the number of blocks", async () => {
    const md = `# T\n\n## S\n\n${Array.from({ length: 300 }, (_, i) => `para ${i}`).join("\n\n")}`;
    const { r, pdf } = await render(md, { limits: { maxBlocks: 50 } });
    expect(r.warnings).toContain("truncated:blocks");
    expect(pdf.text).toContain("para 10");
    expect(pdf.text).not.toContain("para 250");
  });

  it("limits table width", async () => {
    const header = `|${" h |".repeat(20)}`;
    const sep = `|${" --- |".repeat(20)}`;
    const row = `|${" c |".repeat(20)}`;
    const { r } = await render(`# T\n\n## S\n\n${header}\n${sep}\n${row}`);
    expect(r.warnings).toContain("table_columns_truncated");
  });

  it("flattens deeply nested lists and quotes instead of recursing without bound", async () => {
    const nested = Array.from({ length: 60 }, (_, i) => `${"  ".repeat(i)}- level ${i}`).join("\n");
    const quotes = `${">".repeat(40)} deep`;
    const { pdf } = await render(`# T\n\n## S\n\n${nested}\n\n${quotes}`);
    expect(pdf.text).toContain("level 0");
  });

  it("refuses a document over the page cap rather than cutting it", async () => {
    const md = `# T\n\n## S\n\n${Array.from({ length: 400 }, (_, i) => `Paragraph ${i} ${"lorem ".repeat(60)}`).join("\n\n")}`;
    await expect(
      renderPdf(base({ markdown: md, kroki: null, limits: { maxPages: 3 } })),
    ).rejects.toBeInstanceOf(PdfTooLargeError);
  });

  it("shows a Mermaid fence past the diagram caps as code and says so", async () => {
    const kroki = new FakeKroki();
    const fences = Array.from({ length: 3 }, (_, i) => `\`\`\`mermaid\nflowchart LR\n  C${i}-->D\n\`\`\``);
    const { r } = await render(`# T\n\n## S\n\n${fences.join("\n\n")}`, {
      kroki,
      limits: { maxDiagrams: 2 },
    });
    expect(kroki.calls).toHaveLength(2);
    expect(r.warnings).toContain("diagram_over_limit");
  });

  it("does not paint a non-PNG answer from the renderer into the document", async () => {
    const lying = {
      render: async () => Buffer.from("<html>captive portal</html>"),
    };
    const r = await renderPdf(base({ kroki: lying }));
    expect(r.warnings).toEqual(["diagram_unrendered:1"]);
  });
});

describe("HttpKroki: the adapter", () => {
  const fetchReturning = (
    status: number,
    body: Uint8Array | string,
    seen?: { url?: string; body?: string },
  ) =>
    (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (seen) {
        seen.url = String(input);
        seen.body = String(init?.body);
      }
      return new Response(typeof body === "string" ? body : Buffer.from(body), { status });
    }) as typeof fetch;

  it("posts the source as text to /mermaid/png and returns the image", async () => {
    const seen: { url?: string; body?: string } = {};
    const k = new HttpKroki({ baseUrl: "http://kroki:8000/", fetch: fetchReturning(200, TINY_PNG, seen) });
    const png = await k.render("flowchart LR\n A-->B", "png");
    expect(png.equals(TINY_PNG)).toBe(true);
    expect(seen).toEqual({ url: "http://kroki:8000/mermaid/png", body: "flowchart LR\n A-->B" });
  });

  it("reads a 400 as a syntax error carrying the parser's message", async () => {
    const k = new HttpKroki({
      baseUrl: "http://kroki:8000",
      fetch: fetchReturning(400, "Error 400: Parse error on line 2:\n...A--B\n-----^"),
    });
    await expect(k.render("x", "svg")).rejects.toThrow(KrokiSyntaxError);
    await expect(k.render("x", "svg")).rejects.toThrow(/Parse error on line 2/);
  });

  it("reads other failures, a refused connection and a wrong content type as unavailable", async () => {
    const down = new HttpKroki({ baseUrl: "http://kroki:8000", fetch: fetchReturning(503, "no") });
    await expect(down.render("x", "png")).rejects.toThrow(KrokiUnavailableError);
    const refused = new HttpKroki({
      baseUrl: "http://kroki:8000",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(refused.render("x", "png")).rejects.toThrow(KrokiUnavailableError);
    const html = new HttpKroki({ baseUrl: "http://kroki:8000", fetch: fetchReturning(200, "<html></html>") });
    await expect(html.render("x", "png")).rejects.toThrow(KrokiUnavailableError);
  });

  it("refuses an answer over the size cap", async () => {
    const k = new HttpKroki({
      baseUrl: "http://kroki:8000",
      fetch: fetchReturning(200, Buffer.concat([TINY_PNG, Buffer.alloc(5_000)])),
      maxBytes: 1_000,
    });
    await expect(k.render("x", "png")).rejects.toThrow(KrokiUnavailableError);
  });
});
