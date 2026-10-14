import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildParticipantExport, renderParticipantExportMarkdown } from "../src/privacy/export.js";
import { NOT_PARTICIPANT_TABLES, PARTICIPANT_DATA } from "../src/privacy/inventory.js";
import { eraseSession } from "../src/privacy/retention.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * The completeness canary (D-162). The erasure canary scans every column for a planted string
 * after deletion; this is its inverse and its guard:
 *
 *  1. the set of tables that hold participant-linked data is read from `information_schema` and
 *     must equal the inventory, so a new table cannot hold participant data without a decision
 *     about its export and its erasure;
 *  2. every table the inventory says is exported appears in the export with a planted string in
 *     each of its participant-derived columns.
 */
suite("participant data inventory and export are complete (GDPR Art. 15 and 17)", () => {
  const db = new PrismaClient();
  let companyId = "";

  beforeAll(async () => {
    const company = await db.company.create({ data: { name: `Export ${randomBytes(3).toString("hex")}` } });
    companyId = company.id;
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("accounts for every table that holds participant-linked columns", async () => {
    // Tables with a foreign key into the participant-shaped tables, ...
    const byForeignKey = await db.$queryRaw<{ t: string }[]>`
      SELECT DISTINCT tc.table_name AS t
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = 'public'
         AND ccu.table_name IN ('Session', 'Participant', 'Fact', 'Attachment')`;
    // ... plus anything with a column that names a session, a participant or an address.
    const byColumn = await db.$queryRaw<{ t: string }[]>`
      SELECT DISTINCT table_name AS t
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (column_name ~* '(session|participant)id$'
              OR column_name IN ('email', 'emailHash', 'ownerTag'))`;
    const found = new Set<string>([
      ...byForeignKey.map((r) => r.t),
      ...byColumn.map((r) => r.t),
      "Session",
      "Participant",
    ]);
    for (const staff of Object.keys(NOT_PARTICIPANT_TABLES)) found.delete(staff);

    const known = new Set(Object.keys(PARTICIPANT_DATA));
    const missing = [...found].filter((t) => !known.has(t)).sort();
    const stale = [...known].filter((t) => !found.has(t)).sort();
    expect(
      missing,
      `These tables hold participant-linked columns but have no entry in PARTICIPANT_DATA ` +
        `(packages/core/src/privacy/inventory.ts). Decide how the participant gets a copy and how ` +
        `erasure treats it: ${missing.join(", ")}`,
    ).toEqual([]);
    expect(stale, `PARTICIPANT_DATA names tables the schema no longer has or no longer links`).toEqual([]);
  });

  it("exports every included table, with a canary in each participant-derived column", async () => {
    const tag = randomBytes(5).toString("hex");
    const c = (what: string): string => `canary-${what}-${tag}`;

    const template = await db.interviewTemplate.create({
      data: { companyId, key: `k-${tag}`, name: "T", objective: "o", privacyMode: "identified" },
    });
    const user = await db.user.create({
      data: { companyId, email: `staff-${tag}@export.test`, role: "admin" },
    });
    const campaign = await db.campaign.create({
      data: {
        companyId,
        templateId: template.id,
        name: `Campaign ${tag}`,
        participationMode: "identified",
        linkTokenHash: `link-${tag}`,
        verification: "invitation",
        status: "open",
        createdById: user.id,
      },
    });
    const participant = await db.participant.create({
      data: {
        companyId,
        campaignId: campaign.id,
        fields: { _emailHash: `h-${tag}`, name: c("name"), role: c("role") },
        tokenHash: `tok-${tag}`,
      },
    });
    const session = await db.session.create({
      data: {
        companyId,
        templateId: template.id,
        campaignId: campaign.id,
        participantId: participant.id,
        status: "completed",
        consentVersion: c("consent"),
        consentedAt: new Date("2026-10-01T10:00:00Z"),
        state: { participantSummary: c("summary") },
        startedAt: new Date("2026-10-01T10:01:00Z"),
        endedAt: new Date("2026-10-01T10:30:00Z"),
      },
    });
    await db.message.createMany({
      data: [
        { companyId, sessionId: session.id, seq: 1, role: "assistant", content: c("question") },
        { companyId, sessionId: session.id, seq: 2, role: "user", content: c("answer") },
      ],
    });
    await db.fact.create({
      data: {
        companyId,
        sessionId: session.id,
        kind: "pain_point",
        batchEndSeq: 2,
        ordinal: 0,
        payload: { kind: "pain_point", description: c("fact"), quote: c("quote") },
        extractorVersion: "extraction@1",
      },
    });
    await db.attachment.create({
      data: {
        companyId,
        sessionId: session.id,
        kind: "document",
        filename: `${c("filename")}.pdf`,
        mime: "application/pdf",
        sizeBytes: 10,
        storageKey: "",
        summary: c("filesummary"),
      },
    });
    await db.invitation.create({
      data: {
        companyId,
        campaignId: campaign.id,
        emailHash: `ih-${tag}`,
        email: `${c("invitee")}@example.test`,
        tokenHash: `it-${tag}`,
        status: "bound",
        sessionId: session.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const out = await buildParticipantExport(db, { companyId, sessionId: session.id });
    expect(out).not.toBeNull();
    const json = JSON.stringify(out);
    for (const what of [
      "name",
      "role",
      "consent",
      "summary",
      "question",
      "answer",
      "fact",
      "quote",
      "filename",
      "filesummary",
      "invitee",
    ]) {
      expect(json, `the export is missing the planted ${what}`).toContain(c(what));
    }
    // The pseudonymous pointer is not a thing a person can read, and is not handed over.
    expect(json).not.toContain(`h-${tag}`);
    expect(json).not.toContain("_emailHash");

    const md = renderParticipantExportMarkdown(out!);
    for (const what of ["name", "answer", "fact", "quote", "filename", "consent"]) {
      expect(md, `the Markdown is missing the planted ${what}`).toContain(c(what));
    }

    // Every "included" section of the inventory is a key of the export, so the registry cannot
    // promise a section the export does not have.
    const sections = new Set(
      Object.values(PARTICIPANT_DATA).flatMap((t) =>
        t.export.kind === "included" ? [t.export.section] : [],
      ),
    );
    const keys = new Set(Object.keys(out as object));
    for (const section of sections) {
      expect(keys.has(section), `inventory promises a "${section}" section the export lacks`).toBe(true);
    }

    // And once the session is erased there is nothing to export.
    await eraseSession(db, session.id, { markEnded: true, audit: false });
    expect(await buildParticipantExport(db, { companyId, sessionId: session.id })).toBeNull();
  });
});
