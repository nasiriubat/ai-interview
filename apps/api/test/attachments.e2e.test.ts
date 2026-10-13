import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, parseSse, testWorld, TURN_MARKER, type TestWorld } from "./helpers.js";

const suite = describeDb;

/** The first bytes of a WebM/Matroska container, which is what the upload check looks for. */
function webm(tail: string): Buffer {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(tail)]);
}

/**
 * Attachments and recorded voice through the real HTTP surface (FR-30, FR-31, FR-32).
 *
 * The API connects as `app_api` here like every other suite, so these are row-level-security
 * conformance tests as much as feature tests.
 */
suite("attachments and recorded voice", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let transcript: { text: string; duration?: number } | Error = {
    text: "We type the observations twice, once in the patient system and once in the sheet.",
    duration: 6.5,
  };

  const reply = `Thanks. What happens next?\n${TURN_MARKER}\n${JSON.stringify({ areaKey: "daily" })}`;

  beforeAll(async () => {
    model = await fakeModelServer(
      () => reply,
      undefined,
      () => transcript,
    );
    world = await testWorld(model.url);
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  /** Opens a campaign and consents, returning a participant bearer token. */
  async function participant(): Promise<string> {
    const { app, adminToken, templateId } = world;
    const staff = { authorization: `Bearer ${adminToken}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff,
      payload: { templateId, name: `Files ${Math.random().toString(36).slice(2)}`, verification: "open" },
    });
    const { campaign, link } = created.json();
    await app.inject({ method: "POST", url: `/api/v1/campaigns/${campaign.id}/open`, headers: staff });
    const linkToken = link.url.split("/p/")[1] ?? "";

    const opened = await app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/open`,
      payload: {},
    });
    const grant = opened.json();
    const token = `Bearer pt.${grant.participantToken}`;
    await app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: { authorization: token },
      payload: { consentVersion: "v1", participationChoice: "anonymous" },
    });
    return token;
  }

  /**
   * Builds a multipart body by hand. `app.inject` has no file helper, and a hand-built body is
   * also a truer test: it is byte-for-byte what a browser's FormData sends.
   */
  function multipart(
    file: { name: string; type: string; body: Buffer },
    fields: Record<string, string> = {},
  ): { payload: Buffer; headers: Record<string, string> } {
    const boundary = `----test${Math.random().toString(36).slice(2)}`;
    const parts: Buffer[] = [];
    for (const [key, value] of Object.entries(fields)) {
      parts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`),
      );
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
          `Content-Type: ${file.type}\r\n\r\n`,
      ),
      file.body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    return {
      payload: Buffer.concat(parts),
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    };
  }

  it("accepts a document, stores the bytes, and queues it for reading", async () => {
    const token = await participant();
    const body = multipart({
      name: "ward-procedure.txt",
      type: "text/plain",
      body: Buffer.from("Referrals arrive by fax and are retyped into the ward spreadsheet."),
    });

    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/attachments",
      headers: { authorization: token, ...body.headers },
      payload: body.payload,
    });

    expect(res.statusCode).toBe(200);
    const { attachment } = res.json();
    expect(attachment.kind).toBe("document");
    // Pending, not ready: reading it is a job, and the interface says so rather than pretending.
    expect(attachment.status).toBe("pending");
    expect(world.jobs.published.map((j) => j.name)).toContain("attachment.ingest");
    expect(world.storage.size).toBeGreaterThan(0);
  });

  it("refuses a file type that is not on the tenant's list", async () => {
    const token = await participant();
    const body = multipart({ name: "payload.zip", type: "application/zip", body: Buffer.from("PK") });

    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/attachments",
      headers: { authorization: token, ...body.headers },
      payload: body.payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "validation" } });
  });

  it("refuses a file over the tenant's size limit, with a status the client can act on", async () => {
    const token = await participant();
    await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { authorization: `Bearer ${world.adminToken}`, "content-type": "application/json" },
      payload: { scope: "tenant", values: { "files.maxSizeMb": 1 } },
    });
    const body = multipart({
      name: "big.txt",
      type: "text/plain",
      body: Buffer.alloc(2 * 1024 * 1024, 0x61),
    });

    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/attachments",
      headers: { authorization: token, ...body.headers },
      payload: body.payload,
    });

    expect(res.statusCode).toBe(413);
    await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { authorization: `Bearer ${world.adminToken}`, "content-type": "application/json" },
      payload: { scope: "tenant", values: { "files.maxSizeMb": 20 } },
    });
  });

  it("lists, streams back and deletes an attachment", async () => {
    const token = await participant();
    const contents = "The rota is done by hand every Thursday afternoon.";
    const body = multipart({ name: "rota.txt", type: "text/plain", body: Buffer.from(contents) });
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/attachments",
      headers: { authorization: token, ...body.headers },
      payload: body.payload,
    });
    const { attachment } = created.json();

    const listed = await world.app.inject({
      method: "GET",
      url: "/api/v1/p/session/attachments",
      headers: { authorization: token },
    });
    expect(listed.json().attachments).toHaveLength(1);

    const fetched = await world.app.inject({
      method: "GET",
      url: `/api/v1/p/session/attachments/${attachment.id}`,
      headers: { authorization: token },
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.body).toBe(contents);
    // Never inline: these bytes are whatever a participant uploaded, and the API's own origin is
    // not a safe place to render them.
    expect(fetched.headers["content-disposition"]).toContain("attachment;");
    expect(fetched.headers["x-content-type-options"]).toBe("nosniff");

    const removed = await world.app.inject({
      method: "DELETE",
      url: `/api/v1/p/session/attachments/${attachment.id}`,
      headers: { authorization: token },
    });
    expect(removed.statusCode).toBe(200);
    const after = await world.app.inject({
      method: "GET",
      url: "/api/v1/p/session/attachments",
      headers: { authorization: token },
    });
    expect(after.json().attachments).toHaveLength(0);
  });

  it("will not show one participant another participant's attachment", async () => {
    const mine = await participant();
    const theirs = await participant();
    const body = multipart({ name: "secret.txt", type: "text/plain", body: Buffer.from("mine") });
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/attachments",
      headers: { authorization: mine, ...body.headers },
      payload: body.payload,
    });
    const { attachment } = created.json();

    const res = await world.app.inject({
      method: "GET",
      url: `/api/v1/p/session/attachments/${attachment.id}`,
      headers: { authorization: theirs },
    });

    expect(res.statusCode).toBe(404);
  });

  it("turns a recording into a transcribed turn, and keeps the audio", async () => {
    const token = await participant();
    // A first turn, so the interview has a question to answer.
    await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/turns",
      headers: { authorization: token },
    });

    const body = multipart(
      { name: "answer.webm", type: "audio/webm;codecs=opus", body: webm("fake opus bytes") },
      { durationMs: "6500" },
    );
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/voice-turns",
      headers: { authorization: token, ...body.headers },
      payload: body.payload,
    });

    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);

    // The transcript comes first, before the interviewer's reply. A typed answer is already on
    // the participant's screen; a spoken one is not, and without this they would watch the
    // interviewer respond to something they cannot see themselves having said.
    const heard = events.find((e) => e.event === "transcript");
    expect(heard).toBeDefined();
    const heardData = heard?.data as { text: string; attachmentId: string; durationMs?: number };
    expect(heardData.text).toContain("observations twice");
    expect(heardData.attachmentId).toBeTruthy();
    expect(heardData.durationMs).toBe(6500);
    expect(events.indexOf(heard!)).toBeLessThan(events.findIndex((e) => e.event === "turn"));

    // And the interviewer answered it as a normal turn.
    expect(events.some((e) => e.event === "turn")).toBe(true);

    const listed = await world.app.inject({
      method: "GET",
      url: "/api/v1/p/session/attachments",
      headers: { authorization: token },
    });
    const [audio] = listed.json().attachments;
    expect(audio?.kind).toBe("audio");
    expect(audio?.status).toBe("ready");
    // The provider's own duration wins over the browser's estimate: it is what was billed.
    expect(audio?.durationMs).toBe(6500);
  });

  it("says it heard nothing rather than sending an empty answer to the interviewer", async () => {
    const token = await participant();
    await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/turns",
      headers: { authorization: token },
    });
    const previous = transcript;
    transcript = { text: "   " };

    const body = multipart({ name: "silence.webm", type: "audio/webm", body: webm("x") });
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/voice-turns",
      headers: { authorization: token, ...body.headers },
      payload: body.payload,
    });

    transcript = previous;
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/could not hear/i);
  });

  it("keeps the recording when transcription fails, so the participant can retry", async () => {
    const token = await participant();
    await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/turns",
      headers: { authorization: token },
    });
    const previous = transcript;
    transcript = new Error("the transcription host is down");

    const body = multipart({ name: "answer.webm", type: "audio/webm", body: webm("x") });
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/voice-turns",
      headers: { authorization: token, ...body.headers },
      payload: body.payload,
    });
    transcript = previous;

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const listed = await world.app.inject({
      method: "GET",
      url: "/api/v1/p/session/attachments",
      headers: { authorization: token },
    });
    const [audio] = listed.json().attachments;
    expect(audio?.status).toBe("failed");
  });

  it("refuses something that is not audio on the voice path", async () => {
    const token = await participant();
    const body = multipart({ name: "note.txt", type: "text/plain", body: Buffer.from("hello") });

    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/voice-turns",
      headers: { authorization: token, ...body.headers },
      payload: body.payload,
    });

    expect(res.statusCode).toBe(400);
  });

  it("refuses an upload from someone with no participant session", async () => {
    const body = multipart({ name: "a.txt", type: "text/plain", body: Buffer.from("x") });

    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/attachments",
      headers: body.headers,
      payload: body.payload,
    });

    expect(res.statusCode).toBe(401);
  });

  it("tells the browser what it may upload, so it does not have to guess", async () => {
    const token = await participant();

    const res = await world.app.inject({
      method: "GET",
      url: "/api/v1/p/session",
      headers: { authorization: token },
    });

    const { session } = res.json();
    // The alternative is a client that offers a microphone a tenant has turned off, and pre-checks
    // uploads against the shipped defaults rather than the limits actually in force.
    expect(session.capabilities.recordedVoice).toBe(true);
    expect(session.capabilities.fileUpload).toBe(true);
    // Live voice is off until a tenant turns it on, and the browser is told so rather than
    // offering a call that would be refused at the socket.
    expect(session.capabilities.liveVoice).toBe(false);
    expect(session.capabilities.maxSizeMb).toBeGreaterThan(0);
    expect(session.capabilities.allowedTypes).toContain("application/pdf");
    expect(session.attachments).toEqual([]);
  });

  it("reports voice as unavailable when the tenant has turned it off", async () => {
    const admin = { authorization: `Bearer ${world.adminToken}`, "content-type": "application/json" };
    await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: admin,
      payload: { scope: "tenant", values: { "features.recordedVoice": false } },
    });
    const token = await participant();

    const res = await world.app.inject({
      method: "GET",
      url: "/api/v1/p/session",
      headers: { authorization: token },
    });
    const { session } = res.json();
    expect(session.capabilities.recordedVoice).toBe(false);

    // And the route refuses too, so a client that ignores the capability still cannot spend money.
    const body = multipart({ name: "a.webm", type: "audio/webm", body: webm("x") });
    const blocked = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/voice-turns",
      headers: { authorization: token, ...body.headers },
      payload: body.payload,
    });
    expect(blocked.statusCode).toBe(403);

    await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: admin,
      payload: { scope: "tenant", values: { "features.recordedVoice": true } },
    });
  });
});
