import type { Server } from "node:http";
import { shippedTemplate } from "@aidp/db";
import { encode } from "@auth/core/jwt";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handlers } from "../../worker/src/handlers.js";
import { fakeModelServer, parseSse, testWorld, TURN_MARKER, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

const turnReply = `Who is the main user of this, and what do they do today?\n${TURN_MARKER}\n${JSON.stringify(
  {
    areaKey: "users",
    reason: "users unknown",
    stateDelta: {
      coverage: { users: { status: "partial", known: "nurses on the ward" } },
      facts: [
        {
          kind: "spec_field",
          section: "users",
          path: "primary",
          value: { role: "Ward nurse" },
          source: "user",
        },
        {
          kind: "spec_field",
          section: "functional",
          path: "FR-1",
          value: {
            title: "Enter a note once",
            scope: "mvp",
            acceptance: ["A note saved once appears in both systems"],
          },
          source: "user",
        },
      ],
    },
  },
)}`;

const specification = {
  title: "Ward notes",
  sections: [
    { key: "overview", markdown: "Nurses enter ward notes once." },
    { key: "users", markdown: "Model text that the owner's edit must override." },
    { key: "phases", markdown: "" },
  ],
  requirements: [
    { id: "FR-1", title: "Enter a note once", scope: "mvp", acceptance: ["Saved once, visible twice"] },
  ],
  phases: [
    {
      key: "p1",
      name: "Phase 1: single entry",
      goals: ["Notes entered once"],
      tasks: [{ title: "Sync notes to the second system", acceptance: ["Round trip under a minute"] }],
      dependencies: [],
      acceptance: ["FR-1 passes"],
    },
  ],
  openQuestions: [{ question: "Which system is the source of truth?", defaultTaken: "The EHR" }],
  mvp: { in: ["FR-1"], movedOut: [], next: [] },
  diagrams: [],
};

suite("requirements interview end to end", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let memberToken: string;
  let memberEmail: string;

  beforeAll(async () => {
    model = await fakeModelServer(
      () => turnReply,
      (name) => (name === "findings" ? { findings: [] } : name === "specification" ? specification : {}),
    );
    world = await testWorld(model.url);
    const { db, companyId } = world;
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
    memberEmail = `member-${Date.now().toString(36)}@test.io`;
    await db.user.create({ data: { companyId, email: memberEmail, role: "member" } });
    memberToken = await encode({
      token: { email: memberEmail },
      secret: world.ctx.config.AUTH_SECRET,
      salt: "authjs.session-token",
    });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  it("creates from a prompt, interviews with a live spec, versions, exports, invites, and scopes access", async () => {
    const { app, adminToken, db } = world;
    const h = { authorization: `Bearer ${adminToken}` };

    // Create from free text: the prompt lands in the overview section before any turn.
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: h,
      payload: { title: "Ward notes", prompt: "Nurses type every note twice, once per system." },
    });
    expect(created.statusCode).toBe(201);
    const { session } = created.json<{
      session: {
        id: string;
        status: string;
        path: string | null;
        sourceKind: string;
        progress: { areas: unknown[] };
      };
    }>();
    expect(session).toMatchObject({ status: "consented", path: null, sourceKind: "text" });
    expect(session.progress.areas.length).toBeGreaterThan(0);
    const id = session.id;

    const detail = await app.inject({ method: "GET", url: `/api/v1/requirements/${id}`, headers: h });
    expect(detail.statusCode).toBe(200);
    const view = detail.json<{
      spec: { sections: { key: string; status: string; markdown: string }[] };
      versions: unknown[];
      invitations: unknown[];
      messages: unknown[];
    }>();
    const overview = view.spec.sections.find((s) => s.key === "overview");
    expect(overview?.status).toBe("draft");
    expect(overview?.markdown).toContain("Nurses type every note twice");
    expect(view.versions).toEqual([]);
    expect(view.messages).toEqual([]);

    // The template asks for a path: no turn before it is chosen.
    expect(
      (await app.inject({ method: "POST", url: `/api/v1/requirements/${id}/turns`, headers: h })).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/requirements/${id}/path`,
          headers: h,
          payload: { path: "technical" },
        })
      ).statusCode,
    ).toBe(200);

    // One streamed turn: text, turn, then the live spec.
    const first = await app.inject({ method: "POST", url: `/api/v1/requirements/${id}/turns`, headers: h });
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toContain("text/event-stream");
    const events = parseSse(first.body);
    const text = events
      .filter((e) => e.event === "text")
      .map((e) => (e.data as { delta: string }).delta)
      .join("");
    expect(text.trim()).toBe("Who is the main user of this, and what do they do today?");
    expect([...new Set(events.map((e) => e.event))]).toEqual(["text", "turn", "spec"]);
    const spec = (
      events.find((e) => e.event === "spec")?.data as {
        spec: { sections: { key: string; fields: unknown[]; status: string }[]; stats: { fields: number } };
      }
    ).spec;
    expect(spec.stats.fields).toBe(3);
    expect(spec.sections.find((s) => s.key === "users")?.fields).toHaveLength(1);
    expect(spec.sections.find((s) => s.key === "functional")?.status).toBe("draft");

    // An owner edit is authoritative in the live spec.
    const edited = await app.inject({
      method: "PUT",
      url: `/api/v1/requirements/${id}/sections/users`,
      headers: h,
      payload: { markdown: "## Users\n\nWard nurses and the charge nurse who reviews notes." },
    });
    expect(edited.statusCode).toBe(200);
    const users = edited
      .json<{ spec: { sections: { key: string; status: string; markdown: string }[] } }>()
      .spec.sections.find((s) => s.key === "users");
    expect(users?.status).toBe("edited");
    expect(users?.markdown).toContain("charge nurse");
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/requirements/${id}/sections/not_a_section`,
          headers: h,
          payload: { markdown: "x" },
        })
      ).statusCode,
    ).toBe(400);

    // Version: queued through the API, generated by the worker handler, then readable and exportable.
    const queued = await app.inject({
      method: "POST",
      url: `/api/v1/requirements/${id}/versions`,
      headers: h,
      payload: { label: "First cut" },
    });
    expect(queued.statusCode).toBe(202);
    const { version } = queued.json<{
      version: { id: string; version: number; status: string; label?: string };
    }>();
    expect(version).toMatchObject({ version: 1, status: "queued", label: "First cut" });
    expect(world.jobs.published.at(-1)).toMatchObject({
      name: "spec.generate",
      payload: { versionId: version.id, companyId: world.companyId },
      singletonKey: `spec:${id}`,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/requirements/${id}/versions`,
          headers: h,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);

    const silent = pino({ level: "silent" });
    const h2 = handlers({
      db,
      callers: world.ctx.callers,
      settings: world.ctx.settings,
      email: world.email,
      jobs: world.jobs,
      crypto: world.crypto,
      storage: world.storage,
      tenants: world.ctx.tenants,
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
    await h2["spec.generate"]({ versionId: version.id, companyId: world.companyId });

    const got = await app.inject({ method: "GET", url: `/api/v1/requirements/${id}/versions/1`, headers: h });
    expect(got.statusCode).toBe(200);
    const body = got.json<{
      version: {
        status: string;
        error?: string;
        stats: { requirements: number; phases: number; generated?: string };
      };
      document: {
        sections: { key: string; source: string; markdown: string }[];
        requirements: { id: string }[];
      };
      markdown: string;
      bundle: { format: string; files: { path: string }[] };
    }>();
    expect(body.version.status).toBe("done");
    expect(body.version.error).toBeUndefined();
    expect(body.version.stats).toMatchObject({ requirements: 1, phases: 1, generated: "model" });
    expect(body.document.sections.find((s) => s.key === "users")).toMatchObject({ source: "edited" });
    expect(body.document.sections.find((s) => s.key === "overview")).toMatchObject({ source: "generated" });
    expect(body.markdown).toContain("charge nurse");
    expect(body.markdown).not.toContain("owner's edit must override");
    expect(body.bundle.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(["AGENTS.md", "PLAN.md", "spec.md", "spec.json", "tasks/phase-1.md"]),
    );

    const md = await app.inject({
      method: "GET",
      url: `/api/v1/requirements/${id}/versions/1/export?format=md`,
      headers: h,
    });
    expect(md.statusCode).toBe(200);
    expect(md.headers["content-type"]).toContain("text/markdown");
    expect(md.headers["content-disposition"]).toBe('attachment; filename="ward-notes-v1.md"');
    expect(md.body).toContain("charge nurse");
    const zip = await app.inject({
      method: "GET",
      url: `/api/v1/requirements/${id}/versions/1/export?format=bundle`,
      headers: h,
    });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers["content-type"]).toBe("application/zip");
    expect(zip.headers["content-disposition"]).toContain('attachment; filename="ward-notes-v1-bundle.zip"');
    expect(zip.rawPayload.subarray(0, 2).toString("latin1")).toBe("PK");

    const listed = await app.inject({ method: "GET", url: "/api/v1/requirements", headers: h });
    expect(
      listed.json<{ sessions: { id: string; versions: number; openFindings: number }[] }>().sessions,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id, versions: 1, openFindings: 0 })]));

    // External invitation: an email with a personal link, resolvable and openable as a participant.
    const invited = await app.inject({
      method: "POST",
      url: `/api/v1/requirements/${id}/invitations`,
      headers: h,
      payload: { email: "Client@Example.test" },
    });
    expect(invited.statusCode).toBe(200);
    const { invitation } = invited.json<{
      invitation: { id: string; email: string; status: string; tokenHash?: string };
    }>();
    expect(invitation).toMatchObject({ email: "client@example.test", status: "sent" });
    expect(invitation.tokenHash).toBeUndefined();
    const mail = world.email.sent.at(-1);
    expect(mail?.to).toBe("client@example.test");
    const inviteToken = /\/p\/r\/([A-Za-z0-9_-]+)/.exec(mail?.text ?? "")?.[1];
    expect(inviteToken).toBeDefined();

    const arrival = await app.inject({ method: "GET", url: `/api/v1/p/r/${inviteToken}` });
    expect(arrival.statusCode).toBe(200);
    expect(
      arrival.json<{ status: string; session: { title: string; pathSelection: string } }>(),
    ).toMatchObject({
      status: "open",
      session: { title: "Ward notes", pathSelection: "technical_or_not" },
    });
    const opened = await app.inject({ method: "POST", url: `/api/v1/p/r/${inviteToken}/open` });
    expect(opened.statusCode).toBe(200);
    const { participantToken, sessionId, resume } = opened.json<{
      participantToken: string;
      sessionId: string;
      resume: boolean;
    }>();
    expect(sessionId).toBe(id);
    expect(resume).toBe(true);
    const pSession = await app.inject({
      method: "GET",
      url: "/api/v1/p/session",
      headers: { authorization: `Bearer pt.${participantToken}` },
    });
    expect(pSession.statusCode).toBe(200);
    expect(
      pSession.json<{ session: { id: string; consented: boolean; messages: unknown[] } }>().session,
    ).toMatchObject({ id, consented: true });
    const detail2 = await app.inject({ method: "GET", url: `/api/v1/requirements/${id}`, headers: h });
    expect(detail2.json<{ invitations: { status: string }[] }>().invitations).toEqual([
      expect.objectContaining({ id: invitation.id, status: "opened" }),
    ]);

    // Revoking rotates the participant token: the link is dead.
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/requirements/${id}/invitations/${invitation.id}/revoke`,
          headers: h,
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/v1/p/r/${inviteToken}/open` })).statusCode).toBe(
      403,
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/p/session",
          headers: { authorization: `Bearer pt.${participantToken}` },
        })
      ).statusCode,
    ).toBe(401);

    // A member sees only their own sessions and cannot read another owner's.
    const m = { authorization: `Bearer ${memberToken}` };
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/requirements/${id}`, headers: m })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/requirements", headers: m })).json<{
        sessions: unknown[];
      }>().sessions,
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/requirements/${id}/sections/users`,
          headers: m,
          payload: { markdown: "hijack" },
        })
      ).statusCode,
    ).toBe(403);

    // Audit trail of the admin actions.
    const actions = (await db.auditLog.findMany({ where: { targetId: id } })).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "requirements.create",
        "requirements.section_edit",
        "requirements.version",
        "requirements.invite",
        "requirements.revoke",
      ]),
    );
  });

  it("previews a template when the request carries no body at all, as the web client sends it", async () => {
    const { app, adminToken } = world;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/templates/${world.templateId}/preview`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ participantToken: string }>().participantToken).toBeTruthy();
  });

  it("previews a template as a throwaway participant session", async () => {
    const { app, adminToken } = world;
    const h = { authorization: `Bearer ${adminToken}` };
    const preview = await app.inject({
      method: "POST",
      url: `/api/v1/templates/${world.templateId}/preview`,
      headers: h,
      payload: {},
    });
    expect(preview.statusCode).toBe(200);
    const { participantToken, sessionId } = preview.json<{ participantToken: string; sessionId: string }>();
    const view = await app.inject({
      method: "GET",
      url: "/api/v1/p/session",
      headers: { authorization: `Bearer pt.${participantToken}` },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json<{ session: { id: string; consented: boolean } }>().session).toMatchObject({
      id: sessionId,
      consented: true,
    });
    // Previews stay out of the requirements workspace list.
    const listed = await app.inject({ method: "GET", url: "/api/v1/requirements", headers: h });
    expect(listed.json<{ sessions: { id: string }[] }>().sessions.some((s) => s.id === sessionId)).toBe(
      false,
    );
  });
});
