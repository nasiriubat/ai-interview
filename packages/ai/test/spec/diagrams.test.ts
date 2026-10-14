import { SessionStateSchema, type SpecDiagram, type SpecDocument, type SpecEdits } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { renderBundle } from "../../src/spec/bundle.js";
import {
  checkMermaidSource,
  diagramEditKey,
  liveDiagrams,
  MAX_DIAGRAM_BYTES,
  mergeDiagrams,
} from "../../src/spec/diagrams.js";
import { generateSpec, type SpecGenerationInput } from "../../src/spec/generate.js";
import { renderLiveSpec } from "../../src/spec/live.js";
import { renderSpecMarkdown } from "../../src/spec/markdown.js";
import { ScriptedCaller } from "../engine/helpers.js";

const logger = { warn: () => undefined, info: () => undefined };
const now = () => new Date("2026-10-14T10:00:00Z");

const gen = (key: string, mermaid: string, type: SpecDiagram["type"] = "context"): SpecDiagram => ({
  key,
  title: `Diagram ${key}`,
  type,
  mermaid,
});

const edit = (fields: Partial<SpecEdits[string]>): SpecEdits[string] => ({
  markdown: "",
  editedAt: "2026-10-14T09:00:00Z",
  editedBy: "u",
  ...fields,
});

const doc = (over: Partial<SpecDocument>): SpecDocument => ({
  title: "T",
  language: "en",
  path: null,
  generatedAt: "2026-10-14T00:00:00Z",
  context: {},
  sections: [],
  requirements: [],
  phases: [],
  openQuestions: [],
  mvp: { in: [], movedOut: [], next: [] },
  diagrams: [],
  ...over,
});

describe("checkMermaidSource (FR-23: what may be saved as a diagram)", () => {
  const accepted: [string, string][] = [
    ["a flowchart", "flowchart LR\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]"],
    ["a sequence diagram with arrows that contain <", "sequenceDiagram\n  A->>B: hi\n  B-->>A: <<done>>"],
    ["line breaks in labels", "flowchart TD\n  A[First<br/>second] --> B"],
    ["plain comments before the type", "%% a note\nflowchart LR\n  A-->B"],
    ["CRLF line endings", "flowchart LR\r\n  A-->B\r\n"],
    ["an ER diagram", "erDiagram\n  PATIENT ||--o{ CHART : has"],
  ];
  for (const [name, source] of accepted)
    it(`accepts ${name}`, () => {
      expect(checkMermaidSource(source).ok).toBe(true);
    });

  const refused: [string, string, string][] = [
    ["an empty source", "   \n ", "empty"],
    ["text that is not a diagram", "hello world", "unknown_type"],
    ["front matter", "---\nconfig:\n  theme: dark\n---\nflowchart LR\n A-->B", "front_matter"],
    ["an init directive", '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\n A-->B', "directive"],
    ["a click statement", 'flowchart LR\n  A-->B\n  click A callback "tip"', "click"],
    ["an image label", "flowchart LR\n  A[<img src=x onerror=alert(1)>] --> B", "html"],
    ["a script tag", "flowchart LR\n  A[<script>alert(1)</script>] --> B", "html"],
    ["an iframe", "flowchart LR\n  A[<iframe src=//evil></iframe>] --> B", "html"],
    ["a javascript url", 'flowchart LR\n  A["javascript:alert(1)"] --> B', "script"],
    ["a remote url in a label", "flowchart LR\n  A[http://169.254.169.254/latest] --> B", "remote_resource"],
    ["a css url()", "flowchart LR\n  A-->B\n  classDef x fill:url(//evil/a.png)", "remote_resource"],
    ["an image node", 'flowchart LR\n  A@{ img: "x.png", w: 20 }', "remote_resource"],
    ["a control character", "flowchart LR\n  A-->B\u0007", "control_characters"],
  ];
  for (const [name, source, code] of refused)
    it(`refuses ${name}`, () => {
      const r = checkMermaidSource(source);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.map((i) => i.code)).toContain(code);
    });

  it("refuses a source over the size cap and says so", () => {
    const r = checkMermaidSource(`flowchart LR\n${"  A-->B\n".repeat(MAX_DIAGRAM_BYTES / 8 + 10)}`);
    expect(r).toMatchObject({ ok: false, issues: [{ code: "too_large" }] });
  });

  it("reports the line of the problem", () => {
    const r = checkMermaidSource("flowchart LR\n  A-->B\n  click A callback");
    expect(r.ok === false && r.issues[0]?.line).toBe(3);
  });
});

describe("mergeDiagrams (owner edits are authoritative)", () => {
  const generated = [
    gen("ctx", "flowchart LR\n  A-->B"),
    gen("er", "erDiagram\n  X ||--o{ Y : has", "entity"),
  ];

  it("replaces the source of the diagram with the edited key and keeps what was drawn", () => {
    const edits: SpecEdits = {
      [diagramEditKey("ctx")]: edit({
        mermaid: "flowchart LR\n  A-->B-->C",
        description: "Who talks to whom",
      }),
    };
    const merged = mergeDiagrams(generated, edits);
    expect(merged[0]).toMatchObject({
      key: "ctx",
      mermaid: "flowchart LR\n  A-->B-->C",
      description: "Who talks to whom",
      source: "edited",
      original: "flowchart LR\n  A-->B",
    });
    expect(merged[1]).toEqual(generated[1]);
  });

  it("appends a diagram the owner added, after the generated ones", () => {
    const edits: SpecEdits = {
      [diagramEditKey("deploy")]: edit({
        mermaid: "flowchart LR\n  W-->D",
        title: "Deployment",
        type: "containers",
      }),
    };
    const merged = mergeDiagrams(generated, edits);
    expect(merged.map((d) => d.key)).toEqual(["ctx", "er", "deploy"]);
    expect(merged[2]).toMatchObject({ title: "Deployment", type: "containers", source: "added" });
  });

  it("is idempotent, so a regenerated document that already carries an edit does not drift", () => {
    const edits: SpecEdits = {
      [diagramEditKey("ctx")]: edit({ mermaid: "flowchart LR\n  A-->Z" }),
      [diagramEditKey("deploy")]: edit({ mermaid: "flowchart LR\n  W-->D" }),
    };
    const once = mergeDiagrams(generated, edits);
    expect(mergeDiagrams(once, edits)).toEqual(once);
  });

  it("puts back what was drawn when the edit is removed", () => {
    const edits: SpecEdits = { [diagramEditKey("ctx")]: edit({ mermaid: "flowchart LR\n  A-->Z" }) };
    const once = mergeDiagrams(generated, edits);
    const reset = mergeDiagrams(once, {});
    expect(reset[0]).toMatchObject({ key: "ctx", mermaid: "flowchart LR\n  A-->B" });
    expect(reset[0]?.source).not.toBe("edited");
    expect(reset[0]?.original).toBeUndefined();
  });

  it("drops an added diagram whose edit is gone", () => {
    const edits: SpecEdits = { [diagramEditKey("deploy")]: edit({ mermaid: "flowchart LR\n  W-->D" }) };
    const withAdded = mergeDiagrams(generated, edits);
    expect(mergeDiagrams(withAdded, {}).map((d) => d.key)).toEqual(["ctx", "er"]);
  });

  it("ignores an edit with no source rather than blanking the diagram", () => {
    const merged = mergeDiagrams(generated, { [diagramEditKey("ctx")]: edit({ mermaid: "  " }) });
    expect(merged).toEqual(generated);
  });
});

describe("liveDiagrams and the live spec", () => {
  const state = SessionStateSchema.parse({});
  it("lists edits as diagrams and not as sections", () => {
    const edits: SpecEdits = {
      [diagramEditKey("deploy")]: edit({ mermaid: "flowchart LR\n  W-->D", description: "Hosting" }),
    };
    const live = renderLiveSpec({ title: "T", path: null, state, edits, diagrams: [] });
    expect(live.sections.map((s) => s.key)).not.toContain("diagram:deploy");
    expect(live.diagrams).toEqual([
      expect.objectContaining({ key: "deploy", status: "added", description: "Hosting", verified: false }),
    ]);
  });

  it("marks an edit verified once the renderer accepted it", () => {
    const edits: SpecEdits = {
      [diagramEditKey("ctx")]: edit({
        mermaid: "flowchart LR\n  A-->Z",
        validatedAt: "2026-10-14T09:00:01Z",
      }),
    };
    const out = liveDiagrams([gen("ctx", "flowchart LR\n  A-->B")], edits);
    expect(out[0]).toMatchObject({ status: "edited", verified: true, original: "flowchart LR\n  A-->B" });
  });
});

describe("diagram edits across regeneration and in every export", () => {
  const state = SessionStateSchema.parse({
    facts: [{ kind: "spec_field", section: "overview", path: "problem", value: "Charting", source: "user" }],
  });
  const edits: SpecEdits = {
    [diagramEditKey("ctx")]: edit({
      mermaid: "flowchart LR\n  Nurse-->OWNER_EDIT_MARKER",
      description: "Who uses it",
    }),
    [diagramEditKey("deploy")]: edit({ mermaid: "flowchart TD\n  ADDED_MARKER-->B", title: "Deployment" }),
  };
  const input: SpecGenerationInput = {
    companyId: "c",
    sessionId: "s",
    title: "Charting",
    language: "en",
    state,
    summary: "",
    edits,
    sections: ["overview", "diagrams"],
    diagramTypes: ["context"],
    bundleFormat: "generic",
  };
  const output = (mermaid: string): string =>
    JSON.stringify({
      title: "Charting",
      sections: [{ key: "overview", markdown: "x" }],
      diagrams: [{ key: "ctx", title: "Context", type: "context", mermaid }],
    });

  it("keeps the edit when the model draws the same diagram again, differently", async () => {
    for (const drawn of ["flowchart LR\n  A-->B", "flowchart LR\n  P-->Q-->R"]) {
      const caller = new ScriptedCaller([output(drawn)]);
      const r = await generateSpec(
        { caller: caller.asCaller(), prompts: new ShippedPromptSource(), logger, now },
        input,
      );
      const ctx = r.document.diagrams.find((d) => d.key === "ctx");
      expect(ctx).toMatchObject({ source: "edited", original: drawn });
      expect(ctx?.mermaid).toContain("OWNER_EDIT_MARKER");
      expect(r.markdown).toContain("OWNER_EDIT_MARKER");
      expect(r.markdown).toContain("Who uses it");
      expect(r.markdown).not.toContain(drawn.split("\n")[1] ?? "never");
      // the added diagram is in the document, the markdown, the JSON and its own bundle file
      expect(r.markdown).toContain("### Deployment");
      expect(r.markdown).toContain("ADDED_MARKER");
      const spec = JSON.parse(r.bundle.files.find((f) => f.path === "spec.json")?.content ?? "{}") as {
        diagrams: { key: string; mermaid: string }[];
      };
      expect(spec.diagrams.map((d) => d.key)).toEqual(["ctx", "deploy"]);
      expect(r.bundle.files.find((f) => f.path === "diagrams/deploy.mmd")?.content).toContain("ADDED_MARKER");
      expect(r.bundle.files.find((f) => f.path === "diagrams/ctx.mmd")?.content).toContain(
        "OWNER_EDIT_MARKER",
      );
    }
  });

  it("keeps the edits on the fallback path, where nothing was drawn", async () => {
    const caller = new ScriptedCaller(["{ not json"]);
    const r = await generateSpec(
      { caller: caller.asCaller(), prompts: new ShippedPromptSource(), logger, now },
      input,
    );
    expect(r.generated).toBe("fallback");
    // both were the owner's: neither is lost because the model failed
    expect(r.document.diagrams.map((d) => d.key)).toEqual(["ctx", "deploy"]);
    expect(r.markdown).toContain("OWNER_EDIT_MARKER");
  });

  it("does not let a diagram's source end its own fence", () => {
    const md = renderSpecMarkdown(
      doc({
        sections: [{ key: "diagrams", title: "Diagrams", markdown: "", source: "generated" }],
        diagrams: [gen("x", "flowchart LR\n  A[```]-->B")],
      }),
    );
    expect(md).toContain("````mermaid\nflowchart LR\n  A[```]-->B\n````");
  });

  it("puts an added diagram at the end when the document has no diagrams section", () => {
    const md = renderSpecMarkdown(
      doc({
        sections: [{ key: "overview", title: "Overview", markdown: "text", source: "generated" }],
        diagrams: [{ ...gen("x", "flowchart LR\n  A-->B"), source: "added" }],
      }),
    );
    expect(md).toMatch(/## Diagrams\n\n### Diagram x\n\n```mermaid\nflowchart LR/);
  });

  it("sanitizes a generated key into a safe bundle file name and keeps names unique", () => {
    const paths = renderBundle(
      doc({
        diagrams: [gen("../etc/passwd", "flowchart LR\n  A-->B"), gen("etc passwd", "flowchart LR\n  C-->D")],
      }),
      "generic",
      "",
    ).files.map((f) => f.path);
    expect(paths).toContain("diagrams/etc-passwd.mmd");
    expect(paths).toContain("diagrams/etc-passwd-2.mmd");
    expect(paths.some((p) => p.includes(".."))).toBe(false);
  });
});
