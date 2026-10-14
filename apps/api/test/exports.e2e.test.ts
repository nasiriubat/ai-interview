import type { Server } from "node:http";
import { FakeKroki } from "@aidp/core";
import { shippedTemplate } from "@aidp/db";
import { describeDb, readPdf } from "@aidp/testing";
import { encode } from "@auth/core/jwt";
import { pino } from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { handlers } from "../../worker/src/handlers.js";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

/*
 * Exports and editable diagrams (FR-23, D-210 to D-219): the analysis report and the specification
 * versions as PDF, the formats beside them, and the owner's diagram edits across regeneration.
 * The renderer is a FakeKroki: nothing here reaches a network.
 */

const suite = describeDb;

const REPORT_MD = [
  "# Discovery report: Ward processes",
  "",
  "Generated 2026-10-14.",
  "",
  "## Executive summary",
  "",
  "Nurses re-key the same vitals twice. REPORT_MARKER.",
  "",
  "## Opportunities",
  "",
  "| Rank | Opportunity |",
  "| --- | --- |",
  "| 1 | Single-entry charting |",
  "",
  "### Process map",
  "",
  "```mermaid",
  "flowchart LR",
  '  a["Receive"] --> b["Key in"]',
  "```",
].join("\n");

const specification = {
  title: "Ward notes",
  sections: [
    { key: "overview", markdown: "Nurses enter ward notes once." },
    { key: "diagrams", markdown: "" },
  ],
  requirements: [
    { id: "FR-1", title: "Enter a note once", scope: "mvp", acceptance: ["Saved once, visible twice"] },
    { id: "FR-2", title: "Edit a note", scope: "mvp", acceptance: ["An edit shows in both systems"] },
    { id: "FR-3", title: "Export notes", scope: "future", acceptance: ["A CSV downloads"] },
  ],
  phases: [],
  openQuestions: [],
  mvp: { in: ["FR-1", "FR-2"], movedOut: [], next: ["FR-3"] },
  diagrams: [
    { key: "ctx", title: "Context", type: "context", mermaid: "flowchart LR\n  Nurse-->GENERATED_ONE" },
  ],
};

suite("exports and editable diagrams", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  const kroki = new FakeKroki();
  let h: Record<string, string>;
  let memberHeaders: Record<string, string>;
  let campaignId: string;

  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, as = h) =>
    world.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: as,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  beforeAll(async () => {
    model = await fakeModelServer(
      () => "ok",
      (name) => (name === "specification" ? specification : name === "findings" ? { findings: [] } : {}),
    );
    world = await testWorld(
      model.url,
      { RATE_LIMIT_MAX: "100000", RATE_LIMIT_EXPENSIVE_MAX: "100000" },
      {
        kroki,
      },
    );
    const { db, companyId } = world;
    h = { authorization: `Bearer ${world.adminToken}` };
    const memberEmail = `exp-member-${Date.now().toString(36)}@test.io`;
    await db.user.create({ data: { companyId, email: memberEmail, role: "member" } });
    memberHeaders = {
      authorization: `Bearer ${await encode({
        token: { email: memberEmail },
        secret: world.ctx.config.AUTH_SECRET,
        salt: "authjs.session-token",
      })}`,
    };
    // The requirements template and the routes a specification version needs.
    const t = shippedTemplate("requirements_discovery");
    if (!t) throw new Error("shipped requirements template missing");
    await db.interviewTemplate.create({
      data: {
        companyId,
        key: t.key,
        version: 1,
        name: t.name,
        language: t.language,
        objective: t.objective,
        privacyMode: t.privacyMode,
        participantFields: t.participantFields,
        pathSelection: t.pathSelection,
        contextBlock: t.contextBlock,
        coverageAreas: t.coverageAreas,
        aiInstructions: t.aiInstructions,
        adaptivity: t.adaptivity,
        widgetPolicy: t.widgetPolicy,
        issueDetection: t.issueDetection,
        outputs: t.outputs,
        status: "published",
      },
    });
    const provider = await db.provider.findFirstOrThrow({ where: { companyId } });
    for (const purpose of ["issue_detection", "spec_generation"]) {
      await db.route.create({
        data: { companyId, purpose, providerId: provider.id, model: "fake-model", maxOutputTokens: 4000 },
      });
    }
    const campaign = await db.campaign.create({
      data: {
        companyId,
        templateId: world.templateId,
        name: "Ward processes",
        participationMode: "anonymous",
        linkTokenHash: `exp-${Date.now().toString(36)}`,
        createdById: (await db.user.findFirstOrThrow({ where: { email: world.adminEmail } })).id,
      },
    });
    campaignId = campaign.id;
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  async function reportOf(opts: { preliminary?: boolean; markdown?: string; version?: number } = {}) {
    const analysis = await world.db.analysis.create({
      data: {
        companyId: world.companyId,
        campaignId,
        version: opts.version ?? Math.floor(Math.random() * 1_000_000),
        status: "done",
        preliminary: opts.preliminary ?? false,
      },
    });
    const report = await world.db.report.create({
      data: {
        companyId: world.companyId,
        analysisId: analysis.id,
        version: 1,
        markdown: opts.markdown ?? REPORT_MD,
        sections: [],
      },
    });
    return { analysis, report };
  }

  // ---------- the analysis report ----------

  it("downloads the report as a PDF with the tenant's branding, a contents list and the diagram drawn", async () => {
    await call("PUT", "/settings?scope=tenant", {
      values: {
        "branding.productName": "Ward Co Discovery",
        "branding.primaryColor": "#0b6e4f",
        "exports.pdfFooterText": "Internal: not for distribution",
      },
    });
    const { analysis } = await reportOf({ version: 41 });
    kroki.calls.length = 0;
    const res = await call("GET", `/analyses/${analysis.id}/report.pdf`);
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="ward-processes-report-v1.pdf"');
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(res.headers["x-export-warnings"]).toBeUndefined();

    const pdf = await readPdf(res.rawPayload);
    expect(pdf.title).toBe("Discovery report: Ward processes");
    expect(pdf.author).toBe("Ward Co Discovery");
    expect(pdf.pages[0]).toContain("Ward Co Discovery");
    expect(pdf.pages[0]).toContain("Report v1");
    const body = pdf.pages.slice(1).join("\n");
    for (const heading of ["Contents", "Executive summary", "Opportunities", "Process map"])
      expect(body).toContain(heading);
    expect(body).toContain("REPORT_MARKER");
    expect(body).toContain("Single-entry charting");
    expect(body).toContain("Internal: not for distribution");
    expect(pdf.imagesPerPage.reduce((a, b) => a + b, 0)).toBe(1);
    expect(kroki.calls).toHaveLength(1);

    const audit = await world.db.auditLog.findFirstOrThrow({
      where: { companyId: world.companyId, action: "analysis.report_export", targetId: analysis.id },
    });
    expect(audit.diff).toMatchObject({ format: "pdf", version: 1 });
  });

  it("still delivers the report when the renderer is down, with the diagram as source and a warning", async () => {
    const { analysis } = await reportOf();
    kroki.failWith = "unavailable";
    try {
      const res = await call("GET", `/analyses/${analysis.id}/report.pdf`);
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-export-warnings"]).toBe("diagram_unrendered:1");
      const pdf = await readPdf(res.rawPayload);
      expect(pdf.text).toContain("This diagram could not be drawn");
      expect(pdf.text).toContain("flowchart LR");
      expect(pdf.text).toContain("REPORT_MARKER");
    } finally {
      kroki.failWith = null;
    }
  });

  it("refuses what the report page refuses: other tenants, anonymous callers, a preliminary report to a member", async () => {
    const { analysis } = await reportOf({ preliminary: true });
    expect((await call("GET", `/analyses/${analysis.id}/report.pdf`, undefined, {})).statusCode).toBe(401);
    expect(
      (await call("GET", `/analyses/${analysis.id}/report.pdf`, undefined, memberHeaders)).statusCode,
    ).toBe(403);
    const other = await world.db.company.create({ data: { name: `Other ${Date.now().toString(36)}` } });
    const email = `exp-other-${Date.now().toString(36)}@test.io`;
    await world.db.user.create({ data: { companyId: other.id, email, role: "admin" } });
    const otherHeaders = {
      authorization: `Bearer ${await encode({
        token: { email },
        secret: world.ctx.config.AUTH_SECRET,
        salt: "authjs.session-token",
      })}`,
    };
    expect(
      (await call("GET", `/analyses/${analysis.id}/report.pdf`, undefined, otherHeaders)).statusCode,
    ).toBe(404);
    expect((await call("GET", "/analyses/does-not-exist/report.pdf")).statusCode).toBe(404);
  });

  it("answers 409 for an analysis that has no report yet", async () => {
    const analysis = await world.db.analysis.create({
      data: { companyId: world.companyId, campaignId, version: 7_000_001, status: "running" },
    });
    const res = await call("GET", `/analyses/${analysis.id}/report.pdf`);
    expect(res.statusCode).toBe(409);
  });

  it("uses Finnish labels for a Finnish campaign's report", async () => {
    const fi = await world.db.interviewTemplate.create({
      data: {
        companyId: world.companyId,
        key: `fi-${Date.now().toString(36)}`,
        version: 1,
        name: "Suomi",
        language: "fi",
        objective: "o",
        privacyMode: "anonymous",
        status: "published",
      },
    });
    const campaign = await world.db.campaign.create({
      data: {
        companyId: world.companyId,
        templateId: fi.id,
        name: "Osaston prosessit",
        participationMode: "anonymous",
        linkTokenHash: `fi-${Date.now().toString(36)}`,
        createdById: (await world.db.user.findFirstOrThrow({ where: { email: world.adminEmail } })).id,
      },
    });
    const analysis = await world.db.analysis.create({
      data: { companyId: world.companyId, campaignId: campaign.id, version: 1, status: "done" },
    });
    await world.db.report.create({
      data: {
        companyId: world.companyId,
        analysisId: analysis.id,
        version: 1,
        markdown:
          "# Löydösraportti\n\n## Yhteenveto\n\nHoitajat kirjaavat kahdesti.\n\n## Seuraavat askeleet\n\nTee.",
        sections: [],
      },
    });
    const res = await call("GET", `/analyses/${analysis.id}/report.pdf`);
    const pdf = await readPdf(res.rawPayload);
    expect(pdf.pages[0]).toContain("Raportti v1");
    expect(pdf.text).toContain("Sisällys");
    expect(pdf.text).toContain("Hoitajat kirjaavat kahdesti.");
  });

  // ---------- specification versions and diagrams ----------

  it("edits, adds and resets diagrams; validates them; and carries them through generation and every export", async () => {
    const created = await call("POST", "/requirements", { title: "Ward notes" });
    const id = created.json<{ session: { id: string } }>().session.id;
    const base = `/requirements/${id}`;

    // A source the parser refuses is not saved, and the line comes back.
    kroki.rejectContaining = "SYNTAX_FAULT";
    const bad = await call("POST", `${base}/spec/diagrams`, {
      mermaid: "flowchart LR\n  A-->SYNTAX_FAULT",
      description: "Broken",
    });
    kroki.rejectContaining = null;
    expect(bad.statusCode).toBe(400);
    expect(
      bad.json<{ error: { code: string; details: { issues: { message: string }[] } } }>().error,
    ).toMatchObject({
      code: "validation",
      details: { issues: [{ message: expect.stringContaining("SYNTAX_FAULT") }] },
    });
    // Static refusals never reach the renderer.
    const calls = kroki.calls.length;
    const click = await call("POST", `${base}/spec/diagrams`, {
      mermaid: 'flowchart LR\n  A-->B\n  click A callback "x"',
      description: "Clicky",
    });
    expect(click.statusCode).toBe(400);
    expect(kroki.calls.length).toBe(calls);
    // A description is required: it is the caption and the alt text.
    expect(
      (await call("POST", `${base}/spec/diagrams`, { mermaid: "flowchart LR\n  A-->B", description: "  " }))
        .statusCode,
    ).toBe(400);

    // Add one. It appears in the live spec as an added, verified diagram, and is not a section.
    const added = await call("POST", `${base}/spec/diagrams`, {
      mermaid: "flowchart TD\n  ADDED_MARKER-->Hosting",
      description: "Where it runs",
      title: "Deployment",
      type: "containers",
    });
    expect(added.statusCode).toBe(201);
    const addedBody = added.json<{
      key: string;
      verified: boolean;
      spec: { diagrams: { key: string; status: string; verified: boolean }[]; sections: { key: string }[] };
    }>();
    expect(addedBody.verified).toBe(true);
    expect(addedBody.spec.diagrams).toEqual([
      expect.objectContaining({ key: addedBody.key, status: "added", verified: true }),
    ]);
    expect(addedBody.spec.sections.map((s) => s.key).some((k) => k.startsWith("diagram:"))).toBe(false);

    // Generate a version: the model draws "ctx"; the owner's addition is in the document too.
    const queued = await call("POST", `${base}/versions`, {});
    expect(queued.statusCode).toBe(202);
    const versionId = queued.json<{ version: { id: string } }>().version.id;
    const silent = pino({ level: "silent" });
    const worker = handlers({
      db: world.db,
      callers: world.ctx.callers,
      settings: world.ctx.settings,
      email: world.email,
      jobs: world.jobs,
      crypto: world.crypto,
      storage: world.storage,
      tenants: world.ctx.tenants,
      alerts: world.alerts,
      publicWebUrl: "http://web.test",
      log: {
        info: (m, meta) => {
          silent.info(meta ?? {}, m);
        },
        warn: (m, meta) => {
          silent.warn(meta ?? {}, m);
        },
      },
    });
    await worker["spec.generate"]({ versionId, companyId: world.companyId });

    const v1 = (await call("GET", `${base}/versions/1`)).json<{
      document: { diagrams: { key: string; mermaid: string; source?: string }[] };
      markdown: string;
    }>();
    expect(v1.document.diagrams.map((d) => d.key)).toEqual(["ctx", addedBody.key]);
    expect(v1.markdown).toContain("ADDED_MARKER");
    expect(v1.markdown).toContain("Where it runs");
    expect(v1.markdown).toContain("GENERATED_ONE");

    // Now the owner rewrites the generated diagram. The live spec offers the generated one first.
    const live = (await call("GET", base)).json<{
      spec: { diagrams: { key: string; status: string; mermaid: string }[] };
    }>().spec;
    expect(live.diagrams.find((d) => d.key === "ctx")).toMatchObject({ status: "generated" });
    const edited = await call("PUT", `${base}/spec/diagrams/ctx`, {
      mermaid: "flowchart LR\n  Nurse-->OWNER_EDIT_MARKER",
      description: "Who uses it",
    });
    expect(edited.statusCode).toBe(200);
    expect(
      edited
        .json<{ spec: { diagrams: { key: string; status: string; original?: string }[] } }>()
        .spec.diagrams.find((d) => d.key === "ctx"),
    ).toMatchObject({ status: "edited", original: expect.stringContaining("GENERATED_ONE") });

    // Regenerate: the model draws GENERATED_ONE again; the owner's text wins.
    const second = await call("POST", `${base}/versions`, { label: "Second" });
    expect(second.statusCode, second.body).toBe(202);
    await worker["spec.generate"]({
      versionId: second.json<{ version: { id: string } }>().version.id,
      companyId: world.companyId,
    });
    const v2 = (await call("GET", `${base}/versions/2`)).json<{
      document: { diagrams: { key: string; mermaid: string; source?: string }[] };
      markdown: string;
    }>();
    const ctx = v2.document.diagrams.find((d) => d.key === "ctx");
    expect(ctx).toMatchObject({ source: "edited" });
    expect(ctx?.mermaid).toContain("OWNER_EDIT_MARKER");
    expect(v2.markdown).toContain("OWNER_EDIT_MARKER");
    expect(v2.markdown).not.toContain("GENERATED_ONE");

    // Every format carries it.
    const md = await call("GET", `${base}/versions/2/export?format=md`);
    expect(md.body).toContain("OWNER_EDIT_MARKER");
    expect(md.body).toContain("ADDED_MARKER");
    const json = await call("GET", `${base}/versions/2/export?format=json`);
    expect(json.body).toContain("OWNER_EDIT_MARKER");
    const zip = await call("GET", `${base}/versions/2/export?format=bundle`);
    expect(zip.statusCode).toBe(200);
    expect(zip.rawPayload.toString("latin1")).toContain("diagrams/ctx.mmd");

    kroki.calls.length = 0;
    const pdfRes = await call("GET", `${base}/versions/2/export?format=pdf`);
    expect(pdfRes.statusCode, pdfRes.body.slice(0, 200)).toBe(200);
    expect(pdfRes.headers["content-type"]).toBe("application/pdf");
    expect(pdfRes.headers["content-disposition"]).toBe('attachment; filename="ward-notes-v2.pdf"');
    const pdf = await readPdf(pdfRes.rawPayload);
    expect(pdf.pages[0]).toContain("Ward notes");
    expect(pdf.pages[0]).toContain("Version 2: Second");
    expect(pdf.text).toContain("Enter a note once");
    expect(pdf.text).toContain("Where it runs");
    // both diagrams went to the renderer, with the owner's source, and are pictures in the file
    expect(kroki.calls.map((c) => c.source).join("\n")).toContain("OWNER_EDIT_MARKER");
    expect(kroki.calls.map((c) => c.source).join("\n")).toContain("ADDED_MARKER");
    expect(pdf.imagesPerPage.reduce((a, b) => a + b, 0)).toBe(2);
    // the explicit .pdf route is the same file
    const alias = await call("GET", `${base}/versions/2/export.pdf`);
    expect(alias.statusCode).toBe(200);
    expect(alias.headers["content-disposition"]).toBe('attachment; filename="ward-notes-v2.pdf"');
    const row = await world.db.auditLog.findFirstOrThrow({
      where: { companyId: world.companyId, action: "requirements.export", targetId: id },
      orderBy: { createdAt: "desc" },
    });
    expect(row.diff).toMatchObject({ format: "pdf", version: 2 });

    // Reset puts the generated diagram back; removing the added one drops it.
    const reset = await call("DELETE", `${base}/spec/diagrams/ctx`);
    expect(reset.statusCode).toBe(200);
    expect(
      reset
        .json<{ spec: { diagrams: { key: string; status: string; mermaid: string }[] } }>()
        .spec.diagrams.find((d) => d.key === "ctx"),
    ).toMatchObject({ status: "generated", mermaid: expect.stringContaining("GENERATED_ONE") });
    expect((await call("DELETE", `${base}/spec/diagrams/ctx`)).statusCode).toBe(404);
    expect((await call("DELETE", `${base}/spec/diagrams/${addedBody.key}`)).statusCode).toBe(200);
  });

  it("keeps an edit made while the renderer is down, marked unverified", async () => {
    const id = (await call("POST", "/requirements", { title: "Offline edit" })).json<{
      session: { id: string };
    }>().session.id;
    kroki.failWith = "unavailable";
    try {
      const res = await call("POST", `/requirements/${id}/spec/diagrams`, {
        mermaid: "flowchart LR\n  A-->B",
        description: "Saved offline",
      });
      expect(res.statusCode).toBe(201);
      expect(res.json<{ verified: boolean; spec: { diagrams: { verified: boolean }[] } }>()).toMatchObject({
        verified: false,
        spec: { diagrams: [{ verified: false }] },
      });
    } finally {
      kroki.failWith = null;
    }
  });

  it("refuses unsafe or oversized source, and a member editing another owner's specification", async () => {
    const id = (await call("POST", "/requirements", { title: "Guarded" })).json<{ session: { id: string } }>()
      .session.id;
    const post = (mermaid: string, as = h) =>
      call("POST", `/requirements/${id}/spec/diagrams`, { mermaid, description: "d" }, as);
    expect((await post("flowchart LR\n  A[<img src=x onerror=1>]-->B")).statusCode).toBe(400);
    expect((await post(`flowchart LR\n${"  A-->B\n".repeat(4_000)}`)).statusCode).toBe(400);
    expect((await post("flowchart LR\n  A-->B", memberHeaders)).statusCode).toBe(403);
    // none of the refused ones was stored
    const live = (await call("GET", `/requirements/${id}`)).json<{ spec: { diagrams: unknown[] } }>();
    expect(live.spec.diagrams).toEqual([]);
  });
});
