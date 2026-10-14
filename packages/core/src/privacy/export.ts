import type { PrismaClient } from "@prisma/client";

/**
 * A participant's own copy of their data (GDPR Art. 15 and 20, FR-13, D-162).
 *
 * Contains what the person said and gave: their answers (and the questions they answered), the
 * facts recorded about them with the quotes those rest on, the files they attached, the fields they
 * entered and their consent record. It deliberately leaves out derived aggregates (clusters,
 * opportunities, reports): they combine many people's answers and are not a record about one.
 * `PARTICIPANT_DATA` in `inventory.ts` is the list of what is in and what is out, and a test keeps
 * it in step with the schema.
 */
export interface ParticipantExport {
  exportVersion: 1;
  generatedAt: string;
  session: {
    id: string;
    status: string;
    createdAt: string;
    startedAt: string | null;
    endedAt: string | null;
    interview: string | null;
    participation: string | null;
    mode: string;
    path: string | null;
  };
  consent: { version: string | null; givenAt: string | null };
  participant: { fields: Record<string, string> };
  invitation: { email: string | null; status: string; sentAt: string | null } | null;
  summary: string;
  transcript: { seq: number; role: string; modality: string; content: string; at: string }[];
  facts: { kind: string; recordedAt: string; detail: Record<string, unknown> }[];
  files: {
    kind: string;
    filename: string;
    mime: string;
    sizeBytes: number;
    status: string;
    summary: string | null;
    uploadedAt: string;
  }[];
}

export async function buildParticipantExport(
  db: PrismaClient,
  target: { companyId: string; sessionId: string },
  now: Date = new Date(),
): Promise<ParticipantExport | null> {
  const { companyId, sessionId } = target;
  const session = await db.session.findFirst({
    where: { id: sessionId, companyId },
    include: {
      participant: true,
      campaign: { select: { name: true, participationMode: true } },
      template: { select: { name: true } },
    },
  });
  if (!session || session.status === "deleted") return null;

  const [messages, facts, attachments, invitation] = await Promise.all([
    db.message.findMany({ where: { sessionId, companyId }, orderBy: { seq: "asc" } }),
    db.fact.findMany({
      where: { sessionId, companyId },
      orderBy: [{ batchEndSeq: "asc" }, { ordinal: "asc" }],
    }),
    db.attachment.findMany({ where: { sessionId, companyId }, orderBy: { createdAt: "asc" } }),
    db.invitation.findUnique({ where: { sessionId } }),
  ]);

  const { _emailHash: _pointer, ...fields } = (session.participant?.fields ?? {}) as Record<string, string>;
  const state = (session.state ?? {}) as { participantSummary?: unknown };

  return {
    exportVersion: 1,
    generatedAt: now.toISOString(),
    session: {
      id: session.id,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      startedAt: session.startedAt?.toISOString() ?? null,
      endedAt: session.endedAt?.toISOString() ?? null,
      interview: session.campaign?.name ?? session.template.name,
      participation: session.campaign?.participationMode ?? null,
      mode: session.modePreference,
      path: session.path,
    },
    consent: {
      version: session.consentVersion,
      givenAt: session.consentedAt?.toISOString() ?? null,
    },
    participant: { fields },
    invitation:
      invitation?.companyId === companyId
        ? {
            email: invitation.email,
            status: invitation.status,
            sentAt: invitation.sentAt?.toISOString() ?? null,
          }
        : null,
    summary: typeof state.participantSummary === "string" ? state.participantSummary : "",
    transcript: messages.map((m) => ({
      seq: m.seq,
      role: m.role,
      modality: m.modality,
      content: m.content,
      at: m.createdAt.toISOString(),
    })),
    facts: facts.map((f) => ({
      kind: f.kind,
      recordedAt: f.extractedAt.toISOString(),
      detail: (f.payload ?? {}) as Record<string, unknown>,
    })),
    files: attachments.map((a) => ({
      kind: a.kind,
      filename: a.filename,
      mime: a.mime,
      sizeBytes: a.sizeBytes,
      status: a.status,
      summary: a.summary,
      uploadedAt: a.createdAt.toISOString(),
    })),
  };
}

/** The same content as readable Markdown, for a person who will not open JSON. */
export function renderParticipantExportMarkdown(data: ParticipantExport): string {
  const out: string[] = [];
  const quote = (text: string): string =>
    text
      .split(/\r?\n/)
      .map((l) => `> ${l}`)
      .join("\n");
  out.push(`# Your data from the interview "${data.session.interview ?? "Interview"}"`, "");
  out.push(`Generated ${data.generatedAt}. This is everything stored about you in this interview.`, "");

  out.push("## Interview", "");
  out.push(`- Status: ${data.session.status}`);
  out.push(`- Started: ${data.session.startedAt ?? "not yet"}`);
  out.push(`- Ended: ${data.session.endedAt ?? "not yet"}`);
  out.push(`- Answer mode: ${data.session.mode}`, "");

  out.push("## Consent", "");
  out.push(`- Version: ${data.consent.version ?? "none given"}`);
  out.push(`- Given: ${data.consent.givenAt ?? "not given"}`, "");

  out.push("## Details you gave", "");
  const entries = Object.entries(data.participant.fields);
  if (entries.length === 0) out.push("None.");
  for (const [k, v] of entries) out.push(`- ${k}: ${v}`);
  if (data.invitation) {
    out.push("", `You were invited at ${data.invitation.email ?? "an address that has since been removed"}.`);
  }
  out.push("");

  if (data.summary) out.push("## Your summary", "", quote(data.summary), "");

  out.push("## Conversation", "");
  if (data.transcript.length === 0) out.push("No messages.", "");
  for (const m of data.transcript) {
    out.push(`**${m.role === "user" ? "You" : "Interviewer"}** (${m.at})`, "", quote(m.content), "");
  }

  out.push("## What was recorded about you", "");
  if (data.facts.length === 0) out.push("Nothing yet.", "");
  for (const f of data.facts) {
    const d = f.detail;
    const description = typeof d.description === "string" ? d.description : JSON.stringify(d);
    out.push(`- **${f.kind}**: ${description}`);
    if (typeof d.quote === "string") out.push(`  - Your words: "${d.quote}"`);
  }
  out.push("");

  out.push("## Files and recordings", "");
  if (data.files.length === 0) out.push("None.", "");
  for (const f of data.files) {
    out.push(`- ${f.filename} (${f.mime}, ${f.sizeBytes} bytes, ${f.uploadedAt})`);
    if (f.summary) out.push(`  - Summary: ${f.summary}`);
  }
  out.push("");
  return out.join("\n");
}
