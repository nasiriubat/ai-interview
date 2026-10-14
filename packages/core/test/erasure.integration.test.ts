import { randomBytes } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Crypto } from "../src/crypto.js";
import { deleteSessionData, REDACTION_MARK, runRetentionSweep } from "../src/privacy/retention.js";
import { SettingsService } from "../src/settings/service.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

const monthsAgo = (n: number): Date => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
};

/**
 * The erasure canary (S3, D-81).
 *
 * A full graph is seeded in which every field that can hold personal data holds a string that is
 * unique to the test, then the session is erased and EVERY text and JSON column of EVERY table in
 * the database is searched for it. The scan is read from `information_schema`, not from a list in
 * this file, so a table or column added later that stores personal data fails here without anyone
 * remembering to update the test. Hashes cannot be found by text, so what they identify is
 * asserted structurally as well.
 */
suite("erasure leaves no personal data behind (spec 11, FR-13)", () => {
  const db = new PrismaClient();
  const crypto = new Crypto(randomBytes(32).toString("base64"));
  const settings = new SettingsService(db, crypto);
  const log = { info: () => undefined, warn: () => undefined };

  let companyId = "";
  let templateId = "";
  let userId = "";
  let providerId = "";

  beforeAll(async () => {
    const suffix = randomBytes(4).toString("hex");
    const company = await db.company.create({ data: { name: `Erasure ${suffix}` } });
    companyId = company.id;
    templateId = (
      await db.interviewTemplate.create({
        data: { companyId, key: `k-${suffix}`, name: "T", objective: "o", privacyMode: "identified" },
      })
    ).id;
    userId = (
      await db.user.create({ data: { companyId, email: `staff-${suffix}@erasure.test`, role: "admin" } })
    ).id;
    providerId = (
      await db.provider.create({
        data: {
          companyId,
          kind: "openai_compatible",
          name: "fake",
          apiKeyEnc: crypto.encrypt("k", "provider.apiKey"),
        },
      })
    ).id;
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  interface Seeded {
    canary: string;
    quote: string;
    campaignId: string;
    sessionId: string;
    participantId: string;
    emailHash: string;
    invitationId: string;
    analysisId: string;
  }

  /** One participant, one session, and one of everything that can name or quote them. */
  async function seed(opts: { endedAt?: Date | null; createdAt?: Date } = {}): Promise<Seeded> {
    const tag = randomBytes(6).toString("hex");
    const canary = `canary-${tag}@x.io`;
    const quote = `I told them ${canary} is the only way to reach me after hours`;
    const emailHash = crypto.hashEmail(canary);

    const campaign = await db.campaign.create({
      data: {
        companyId,
        templateId,
        name: `Campaign ${tag}`,
        participationMode: "identified",
        linkTokenHash: `link-${tag}`,
        verification: "email_code",
        status: "open",
        createdById: userId,
      },
    });
    const participant = await db.participant.create({
      data: {
        companyId,
        campaignId: campaign.id,
        fields: { _emailHash: emailHash, email: canary, name: `Eve ${canary}`, role: `Nurse ${canary}` },
        tokenHash: `tok-${tag}`,
      },
    });
    const session = await db.session.create({
      data: {
        companyId,
        templateId,
        campaignId: campaign.id,
        participantId: participant.id,
        status: "completed",
        title: `Title ${canary}`,
        handoff: { note: canary },
        specEdits: { goal: `goal ${canary}` },
        invitations: [{ id: "inv_1", email: canary, status: "sent", tokenHash: `ih-${tag}` }],
        state: { participantSummary: canary, facts: [{ quote }] },
        summary: `Summary mentioning ${canary}`,
        consentVersion: "v1",
        consentedAt: new Date(),
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        ...(opts.endedAt === undefined ? {} : { endedAt: opts.endedAt }),
      },
    });
    const message = await db.message.create({
      data: { companyId, sessionId: session.id, seq: 1, role: "user", content: quote },
    });
    await db.message.create({
      data: { companyId, sessionId: session.id, seq: 2, role: "assistant", content: `Thanks ${canary}` },
    });
    await db.sessionEvent.create({
      data: { companyId, sessionId: session.id, seq: 1, type: "state_delta", payload: { who: canary } },
    });
    const fact = await db.fact.create({
      data: {
        companyId,
        sessionId: session.id,
        kind: "pain_point",
        batchEndSeq: 2,
        ordinal: 0,
        payload: { kind: "pain_point", description: `about ${canary}`, severity: 5, quote },
        extractorVersion: "extraction@1",
      },
    });
    const attachment = await db.attachment.create({
      data: {
        companyId,
        sessionId: session.id,
        messageId: message.id,
        kind: "document",
        filename: `${canary}.pdf`,
        mime: "application/pdf",
        sizeBytes: 12,
        storageKey: `${companyId}/${session.id}/${tag}`,
        extractedText: `text ${canary}`,
        summary: `summary ${canary}`,
      },
    });
    await db.attachmentChunk.create({
      data: { companyId, attachmentId: attachment.id, seq: 0, text: `chunk ${canary}` },
    });
    await db.specVersion.create({
      data: {
        companyId,
        sessionId: session.id,
        version: 1,
        label: `v1 ${canary}`,
        spec: { title: canary },
        specMd: `# ${canary}`,
        bundle: { readme: canary },
        issues: [{ message: canary }],
      },
    });

    // The aggregate that quotes the participant: an analysis, a report and an opportunity.
    const analysis = await db.analysis.create({
      data: { companyId, campaignId: campaign.id, version: 1, status: "done", stats: { sessions: 1 } },
    });
    const opportunity = await db.opportunity.create({
      data: {
        companyId,
        analysisId: analysis.id,
        title: "Fewer handover calls",
        summary: `Several people said "${quote}" in some form`,
        rationale: `Because ${quote}`,
        solutionClass: "automation",
        factors: { frequency: { score: 4, rationale: `quote: ${quote}` } },
        rankScore: 1,
        clusterKey: `c-${tag}`,
      },
    });
    await db.opportunityEvidence.create({
      data: { companyId, opportunityId: opportunity.id, factId: fact.id, snippet: quote },
    });
    await db.report.create({
      data: {
        companyId,
        analysisId: analysis.id,
        version: 1,
        markdown: `# Report\n\n> ${quote}\n\nCounts: 1 participant.`,
        sections: [{ title: "Evidence", body: `> ${quote}` }],
      },
    });

    const invitation = await db.invitation.create({
      data: {
        companyId,
        campaignId: campaign.id,
        emailHash,
        email: canary,
        tokenHash: `invtok-${tag}`,
        status: "bound",
        sessionId: session.id,
        sentAt: new Date("2025-03-04T13:14:15Z"),
        openedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await db.campaignEmailHash.create({ data: { companyId, campaignId: campaign.id, emailHash } });
    await db.emailCode.create({
      data: {
        companyId,
        campaignId: campaign.id,
        emailHash,
        codeHash: "x",
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await db.llmCall.create({
      data: {
        companyId,
        purpose: "interview_turn",
        providerId,
        model: "fake",
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 20,
        status: "ok",
        costCents: 1.5,
        sessionId: session.id,
        campaignId: campaign.id,
      },
    });
    return {
      canary,
      quote,
      campaignId: campaign.id,
      sessionId: session.id,
      participantId: participant.id,
      emailHash,
      invitationId: invitation.id,
      analysisId: analysis.id,
    };
  }

  /** Every text and JSON column of every base table, found in the catalogue rather than listed here. */
  async function columnsThatCanHoldText(): Promise<{ table: string; column: string }[]> {
    return db.$queryRaw<{ table: string; column: string }[]>`
      SELECT c.table_name AS "table", c.column_name AS "column"
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public'
         AND t.table_type = 'BASE TABLE'
         AND c.table_name <> '_prisma_migrations'
         AND c.data_type IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY')`;
  }

  async function findCanary(canary: string): Promise<string[]> {
    const columns = await columnsThatCanHoldText();
    expect(columns.length).toBeGreaterThan(60); // the scan is not vacuous
    const found: string[] = [];
    for (const { table, column } of columns) {
      const rows = await db.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "${table}" WHERE "${column}"::text ILIKE $1`,
        `%${canary}%`,
      );
      if ((rows[0]?.n ?? 0) > 0) found.push(`${table}.${column}`);
    }
    return found;
  }

  it("finds the canary before the erase (the scan can see what it is looking for)", async () => {
    const s = await seed();
    const before = await findCanary(s.canary);
    for (const place of [
      "Participant.fields",
      "Invitation.email",
      "Message.content",
      "Session.title",
      "Session.handoff",
      "Session.invitations",
      "SpecVersion.specMd",
      "Report.markdown",
      "Opportunity.summary",
      "OpportunityEvidence.snippet",
      "AttachmentChunk.text",
      "Attachment.filename",
    ]) {
      expect(before).toContain(place);
    }
  });

  it("participant deletion removes the canary from every column of every table", async () => {
    const s = await seed();
    await deleteSessionData(db, s.sessionId, { markEnded: true });

    expect(await findCanary(s.canary)).toEqual([]);

    // The structure the text scan cannot see: hashes and links.
    expect(await db.participant.count({ where: { id: s.participantId } })).toBe(0);
    expect(
      await db.campaignEmailHash.count({ where: { campaignId: s.campaignId, emailHash: s.emailHash } }),
    ).toBe(0);
    expect(await db.emailCode.count({ where: { campaignId: s.campaignId, emailHash: s.emailHash } })).toBe(0);
    expect(await db.invitation.count({ where: { campaignId: s.campaignId, emailHash: s.emailHash } })).toBe(
      0,
    );
    const invitation = await db.invitation.findUniqueOrThrow({ where: { id: s.invitationId } });
    expect(invitation).toMatchObject({
      email: null,
      status: "revoked",
      sessionId: null,
      openedAt: null,
    });
    expect(invitation.emailHash).toMatch(/^deleted:/);
    // Kept for send counts, at day resolution.
    expect(invitation.sentAt?.toISOString()).toBe("2025-03-04T00:00:00.000Z");

    const session = await db.session.findUniqueOrThrow({ where: { id: s.sessionId } });
    expect(session).toMatchObject({
      status: "deleted",
      state: {},
      summary: "",
      title: "",
      specEdits: {},
      invitations: [],
      participantId: null,
      turnLockedAt: null,
    });
    expect(session.handoff).toBeNull();
    // What is retained on purpose: consent evidence and the row itself.
    expect(session.consentVersion).toBe("v1");
    expect(session.consentedAt).not.toBeNull();
    expect(await db.specVersion.count({ where: { sessionId: s.sessionId } })).toBe(0);
    expect(
      await db.attachmentChunk.count({ where: { companyId, attachment: { sessionId: s.sessionId } } }),
    ).toBe(0);

    // The cost ledger and the aggregates stay.
    expect(await db.llmCall.count({ where: { sessionId: s.sessionId } })).toBe(1);
    const report = await db.report.findFirstOrThrow({ where: { analysisId: s.analysisId } });
    expect(report.markdown).toContain(REDACTION_MARK);
    expect(report.markdown).toContain("Counts: 1 participant.");
    expect(JSON.stringify(report.sections)).toContain(REDACTION_MARK);
    const analysis = await db.analysis.findUniqueOrThrow({ where: { id: s.analysisId } });
    expect(analysis.stats).toMatchObject({ sessions: 1, stale: true });
    const audit = await db.auditLog.findFirst({
      where: { companyId, action: "privacy.session_deleted", targetId: s.sessionId },
    });
    expect(audit).not.toBeNull();
  });

  it("is idempotent: a second erase changes nothing and records nothing new", async () => {
    const s = await seed();
    await deleteSessionData(db, s.sessionId, { markEnded: true });
    await deleteSessionData(db, s.sessionId, { markEnded: true });
    expect(await findCanary(s.canary)).toEqual([]);
    expect(
      await db.auditLog.count({
        where: { companyId, action: "privacy.session_deleted", targetId: s.sessionId },
      }),
    ).toBe(1);
  });

  it("the retention sweep removes the same things as participant deletion", async () => {
    const s = await seed({ createdAt: monthsAgo(31), endedAt: monthsAgo(30) });
    const sweeps = await runRetentionSweep({ db, settings, log });
    expect(sweeps.find((x) => x.companyId === companyId)?.deleted).toBeGreaterThanOrEqual(1);

    expect(await findCanary(s.canary)).toEqual([]);
    expect(await db.participant.count({ where: { id: s.participantId } })).toBe(0);
    expect(await db.campaignEmailHash.count({ where: { campaignId: s.campaignId } })).toBe(0);
    expect(await db.emailCode.count({ where: { campaignId: s.campaignId } })).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: s.invitationId } })).email).toBeNull();
    const report = await db.report.findFirstOrThrow({ where: { analysisId: s.analysisId } });
    expect(report.markdown).toContain(REDACTION_MARK);
  });

  it("the sweep also removes participants a deletion made before this change left behind", async () => {
    const s = await seed();
    // Reproduce the old shape: session blanked and marked deleted, participant and the rest kept.
    await db.message.deleteMany({ where: { sessionId: s.sessionId } });
    await db.fact.deleteMany({ where: { sessionId: s.sessionId } });
    await db.sessionEvent.deleteMany({ where: { sessionId: s.sessionId } });
    await db.attachment.deleteMany({ where: { sessionId: s.sessionId } });
    await db.specVersion.deleteMany({ where: { sessionId: s.sessionId } });
    await db.session.update({
      where: { id: s.sessionId },
      data: {
        status: "deleted",
        state: {},
        summary: "",
        title: "",
        specEdits: {},
        invitations: [],
        handoff: Prisma.DbNull,
      },
    });
    await db.report.deleteMany({ where: { analysisId: s.analysisId } });
    await db.opportunity.deleteMany({ where: { analysisId: s.analysisId } });

    // Inside the grace window nothing is touched: the participant row is recent.
    await runRetentionSweep({ db, settings, log });
    expect(await db.participant.count({ where: { id: s.participantId } })).toBe(1);

    await db.participant.update({
      where: { id: s.participantId },
      data: { createdAt: new Date(Date.now() - 10 * 86_400_000) },
    });
    await runRetentionSweep({ db, settings, log });
    expect(await db.participant.count({ where: { id: s.participantId } })).toBe(0);
    expect(await db.campaignEmailHash.count({ where: { campaignId: s.campaignId } })).toBe(0);
    expect(await db.emailCode.count({ where: { campaignId: s.campaignId } })).toBe(0);
    expect(await findCanary(s.canary)).toEqual([]);
  });

  it("a deleted session refuses new content at the database", async () => {
    const s = await seed();
    await deleteSessionData(db, s.sessionId, { markEnded: true });

    await expect(
      db.message.create({
        data: { companyId, sessionId: s.sessionId, seq: 9, role: "user", content: "late" },
      }),
    ).rejects.toThrow(/session_deleted/);
    await expect(
      db.fact.create({
        data: {
          companyId,
          sessionId: s.sessionId,
          kind: "task",
          batchEndSeq: 9,
          ordinal: 0,
          payload: {},
          extractorVersion: "x",
        },
      }),
    ).rejects.toThrow(/session_deleted/);
    await expect(
      db.session.update({ where: { id: s.sessionId }, data: { summary: "late summary" } }),
    ).rejects.toThrow(/session_deleted/);
    await expect(
      db.session.update({ where: { id: s.sessionId }, data: { status: "active" } }),
    ).rejects.toThrow(/session_deleted/);
    expect(await db.message.count({ where: { sessionId: s.sessionId } })).toBe(0);
  });

  it("a write that is in flight when the erase starts is removed by it, not left behind", async () => {
    const s = await seed();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const insertedSignal = new Promise<void>((r) => (inserted = r));

    // A turn mid-flight: it has inserted a message and has not committed yet.
    const turn = db.$transaction(async (tx) => {
      await tx.message.create({
        data: { companyId, sessionId: s.sessionId, seq: 7, role: "user", content: s.canary },
      });
      inserted();
      await gate;
    });
    await insertedSignal;
    // The erase must wait for the turn's row lock, then see and delete its message.
    const erase = deleteSessionData(db, s.sessionId, { markEnded: true });
    await new Promise((r) => setTimeout(r, 150));
    release();
    await Promise.all([turn, erase]);

    expect(await db.message.count({ where: { sessionId: s.sessionId } })).toBe(0);
    expect(await findCanary(s.canary)).toEqual([]);
  });
});
