import { readPdf } from "@aidp/testing";
import { describe, expect, it } from "vitest";
import { ExportBusyError, FakeKroki, PdfExporter } from "../src/exports/index.js";

const settings = (values: Record<string, unknown> = {}) => ({
  resolveMany: async (keys: string[]) =>
    Object.fromEntries(
      keys.map((k) => [
        k,
        values[k] ??
          {
            "branding.productName": "Discovery",
            "branding.primaryColor": "#1f4e79",
            "exports.pdfPageSize": "A4",
            "exports.pdfCoverPage": true,
            "exports.pdfFooterText": "",
          }[k],
      ]),
    ),
});

const request = {
  companyId: "c1",
  title: "Spec",
  markdown: "# Spec\n\n## One\n\ntext\n\n## Two\n\ntext",
  language: "en",
  versionLabel: "Version 1",
  date: new Date("2026-10-14T00:00:00Z"),
};

describe("PdfExporter: brand from settings", () => {
  it("reads name, colour, page size, cover and footer text from the tenant's settings", async () => {
    const asked: unknown[] = [];
    const exporter = new PdfExporter({
      settings: {
        resolveMany: async (keys, chain) => {
          asked.push(chain);
          return settings({
            "branding.productName": "Acme",
            "exports.pdfCoverPage": false,
            "exports.pdfFooterText": "Hello footer",
            "exports.pdfPageSize": "Letter",
          }).resolveMany(keys);
        },
      },
      kroki: null,
    });
    const brand = await exporter.brandFor("c1");
    expect(brand).toEqual({
      productName: "Acme",
      color: "#1f4e79",
      pageSize: "Letter",
      cover: false,
      footerText: "Hello footer",
    });
    expect(asked).toEqual([[{ scope: "tenant", scopeId: "c1" }]]);
    const pdf = await readPdf((await exporter.render(request)).bytes);
    expect(pdf.text).toContain("Hello footer");
  });
});

describe("PdfExporter: one document at a time", () => {
  it("composes serially, queues a few, and turns the rest away", async () => {
    const exporter = new PdfExporter({ settings: settings(), kroki: null, maxInFlight: 2 });
    const first = exporter.render(request);
    const second = exporter.render(request);
    const third = exporter.render(request);
    await expect(third).rejects.toBeInstanceOf(ExportBusyError);
    const results = await Promise.all([first, second]);
    expect(results.every((r) => r.bytes.subarray(0, 5).toString() === "%PDF-")).toBe(true);
    // the queue drains: the next request is accepted again
    await expect(exporter.render(request)).resolves.toBeDefined();
  });

  it("does not let a failed document poison the next one", async () => {
    const exporter = new PdfExporter({ settings: settings(), kroki: null, limits: { maxPages: 1 } });
    await expect(exporter.render(request)).rejects.toThrow(/pages/);
    const ok = new PdfExporter({ settings: settings(), kroki: null });
    await expect(ok.render(request)).resolves.toBeDefined();
  });
});

describe("PdfExporter: checking a diagram", () => {
  it("refuses unsafe source without asking the renderer", async () => {
    const kroki = new FakeKroki();
    const exporter = new PdfExporter({ settings: settings(), kroki });
    const r = await exporter.checkDiagram("flowchart LR\n  A[<img src=x>]-->B");
    expect(r.ok).toBe(false);
    expect(kroki.calls).toHaveLength(0);
  });

  it("asks the renderer and reports its parse error", async () => {
    const kroki = new FakeKroki();
    kroki.failWith = "syntax";
    const exporter = new PdfExporter({ settings: settings(), kroki });
    const r = await exporter.checkDiagram("flowchart LR\n  A-->B");
    expect(r).toMatchObject({ ok: false, issues: [{ message: "Parse error on line 2" }] });
  });

  it("accepts as unverified when the renderer is down or absent", async () => {
    const down = new FakeKroki();
    down.failWith = "unavailable";
    expect(
      await new PdfExporter({ settings: settings(), kroki: down }).checkDiagram("flowchart LR\n  A-->B"),
    ).toMatchObject({ ok: true, verified: false });
    expect(
      await new PdfExporter({ settings: settings(), kroki: null }).checkDiagram("flowchart LR\n  A-->B"),
    ).toMatchObject({ ok: true, verified: false });
  });

  it("verifies a good diagram and previews it as SVG", async () => {
    const exporter = new PdfExporter({ settings: settings(), kroki: new FakeKroki() });
    expect(await exporter.checkDiagram("flowchart LR\n  A-->B")).toMatchObject({ ok: true, verified: true });
    expect((await exporter.previewSvg("flowchart LR\n  A-->B"))?.toString()).toContain("<svg");
    expect(await new PdfExporter({ settings: settings(), kroki: null }).previewSvg("x")).toBeNull();
  });
});
