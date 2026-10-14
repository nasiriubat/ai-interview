import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@/lib/api/http";
import { requirementsSessionApi, toParticipantSession } from "@/lib/api/requirements-session";
import { RequirementsDetailSchema } from "@/lib/api/schemas";
import { specExportUrl, staffApi } from "@/lib/api/staff";

interface Call {
  path: string;
  method: string;
  body?: unknown;
}

function fakeTransport(reply: (call: Call) => unknown): { transport: Transport; calls: Call[] } {
  const calls: Call[] = [];
  const transport: Transport = {
    fetch: (path, init) => {
      const call: Call = {
        path,
        method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
      };
      calls.push(call);
      const out = reply(call);
      if (out instanceof Response) return Promise.resolve(out);
      return Promise.resolve(
        new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } }),
      );
    },
  };
  return { transport, calls };
}

const detail = {
  session: {
    id: "s1",
    title: "Clinic booking",
    status: "active",
    path: "technical",
    language: "en",
    progress: { areas: [{ key: "problem", name: "Problem", status: "partial" }] },
  },
  messages: [{ id: "m1", seq: 1, role: "assistant", content: "Hello", createdAt: "" }],
  spec: {
    title: "Clinic booking",
    path: "technical",
    context: {},
    sections: [],
    findings: [],
    decisions: [],
  },
  versions: [],
  invitations: [],
};

describe("requirementsSessionApi", () => {
  it("maps the participant calls onto the staff requirements routes", async () => {
    const { transport, calls } = fakeTransport((call) => {
      if (call.path === "/requirements/s1") return detail;
      if (call.path.endsWith("/turns")) {
        return new Response("event: ended\ndata: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return { ok: true };
    });
    const api = requirementsSessionApi("s1", staffApi(transport));

    const session = await api.getSession();
    expect(session).toMatchObject({ id: "s1", status: "active", path: "technical", consented: true });
    expect(session.messages.map((m) => m.content)).toEqual(["Hello"]);
    expect(session.progress.areas[0]?.status).toBe("partial");

    await api.setPath("nontechnical");
    await api.sendControl({ type: "finish" });
    await api.pause();
    await api.setMode("options");
    const res = await api.sendTurn({ content: "Hi", modality: "text" });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await api.sendTurn(undefined);

    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["GET", "/requirements/s1"],
      ["POST", "/requirements/s1/path"],
      ["POST", "/requirements/s1/turns"],
      ["POST", "/requirements/s1/turns"],
      ["POST", "/requirements/s1/turns"],
    ]);
    expect(calls[1]?.body).toEqual({ path: "nontechnical" });
    // "I'm done" is a control on the turn request, not a message and not a second endpoint.
    expect(calls[2]?.body).toEqual({ control: { type: "finish" } });
    expect(calls[3]?.body).toEqual({ content: "Hi", modality: "text" });
    expect(calls[4]?.body).toBeUndefined();
  });

  it("rejects the participant-only calls with 'not available'", async () => {
    const { transport } = fakeTransport(() => ({ ok: true }));
    const api = requirementsSessionApi("s1", staffApi(transport));
    await expect(api.deleteData()).rejects.toThrow("not available");
    await expect(api.getSummary()).rejects.toThrow("not available");
    await expect(api.putSummary("x")).rejects.toThrow("not available");
  });

  it("converts a workspace detail into the hook's session shape", () => {
    const parsed = RequirementsDetailSchema.parse({ ...detail, session: { ...detail.session, path: null } });
    expect(toParticipantSession(parsed)).toMatchObject({
      id: "s1",
      path: null,
      modePreference: null,
      summary: null,
    });
  });
});

describe("staffApi.requirements", () => {
  it("sends section edits, finding outcomes, versions and invitations to the contract paths", async () => {
    const spec = { title: "x", path: null, context: {}, sections: [], findings: [], decisions: [] };
    const { transport, calls } = fakeTransport((call) => {
      if (call.path.includes("/sections/") || call.path.includes("/findings/")) return { spec };
      if (call.path.endsWith("/versions") && call.method === "POST") {
        return { version: { id: "v1", version: 1, status: "queued", createdAt: "" } };
      }
      if (call.path.endsWith("/invitations")) {
        return { invitation: { id: "i1", email: "a@b.c", status: "sent", sentAt: "", expiresAt: "" } };
      }
      if (call.path.endsWith("/github")) return { commitUrl: "https://github.com/o/r/commit/1", files: 5 };
      return { ok: true };
    });
    const api = staffApi(transport).requirements;

    const edited = await api.editSection("s1", "overview", "# New");
    expect(edited.title).toBe("x");
    const settled = await api.settleFinding("s1", "f1", "deferred", "later");
    expect(settled.stats.openFindings).toBe(0);
    const version = await api.versions.create("s1", "first");
    expect(version.status).toBe("queued");
    await api.versions.create("s1");
    const inv = await api.invitations.create("s1", "a@b.c");
    expect(inv.id).toBe("i1");
    await api.invitations.revoke("s1", "i1");
    const push = await api.versions.github("s1", 1, { repository: "o/r", token: "ghp_x", branch: "main" });
    expect(push.files).toBe(5);
    await api.reopen("s1");

    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["PUT", "/requirements/s1/sections/overview", { markdown: "# New" }],
      ["POST", "/requirements/s1/findings/f1", { outcome: "deferred", note: "later" }],
      ["POST", "/requirements/s1/versions", { label: "first" }],
      ["POST", "/requirements/s1/versions", {}],
      ["POST", "/requirements/s1/invitations", { email: "a@b.c" }],
      ["POST", "/requirements/s1/invitations/i1/revoke", undefined],
      ["POST", "/requirements/s1/versions/1/github", { repository: "o/r", token: "ghp_x", branch: "main" }],
      ["POST", "/requirements/s1/reopen", undefined],
    ]);
  });

  it("builds export URLs through the staff proxy", () => {
    expect(specExportUrl("s1", 2, "md")).toBe("/api/staff/requirements/s1/versions/2/export?format=md");
    expect(staffApi({ fetch: vi.fn() }).requirements.versions.exportUrl("a b", "3", "bundle")).toBe(
      "/api/staff/requirements/a%20b/versions/3/export?format=bundle",
    );
  });
});
