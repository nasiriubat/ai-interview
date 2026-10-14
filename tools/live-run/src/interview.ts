import { Api, type TurnInput, type TurnMessage, type TurnOutcome, type Widget } from "./api.js";
import type { Persona } from "./personas.js";
import { simulatorSystemPrompt } from "./personas.js";
import { abortState, log, sleep } from "./runtime.js";
import {
  simulateReply,
  simulateWidget,
  widgetInput,
  type Exchange,
  type SimulatorConfig,
} from "./simulator.js";

export interface TurnRecord {
  index: number;
  assistantText: string;
  widget: Widget | null;
  areaKey: string | null;
  firstTokenMs: number | null;
  totalMs: number;
  /** What the participant answered with, and how. */
  reply: { modality: "text" | "widget"; text: string } | null;
  error: { code: string; message: string } | null;
  retried: number;
}

export interface FactRecord {
  id?: string;
  kind: string;
  [key: string]: unknown;
}

export interface InterviewResult {
  persona: Persona;
  sessionId: string;
  participantToken: string;
  ended: boolean;
  endReason: string;
  turns: TurnRecord[];
  areas: { key: string; name: string; status: string }[];
  facts: FactRecord[];
  summary: string;
  summaryEdited: boolean;
  startedAt: number;
  finishedAt: number;
  notes: string[];
}

interface CampaignView {
  campaign: { consentVersion?: string; consentText?: string };
  status: string;
}

export interface InterviewOptions {
  linkToken: string;
  persona: Persona;
  sim: SimulatorConfig;
  /** Stop asking for more after this many assistant turns and press "I'm done". */
  maxTurns: number;
  /** Persona index, used to vary behaviour deterministically. */
  index: number;
}

const MAX_RETRIES = 2;

export async function runInterview(opts: InterviewOptions): Promise<InterviewResult> {
  const { persona, linkToken, sim } = opts;
  const actor = `participant:${persona.id}`;
  const anon = new Api(actor, "");
  const notes: string[] = [];
  const result: InterviewResult = {
    persona,
    sessionId: "",
    participantToken: "",
    ended: false,
    endReason: "",
    turns: [],
    areas: [],
    facts: [],
    summary: "",
    summaryEdited: false,
    startedAt: Date.now(),
    finishedAt: 0,
    notes,
  };

  const arrival = await anon.ok<CampaignView>("GET", `/p/${linkToken}`);
  if (arrival.status !== "open") throw new Error(`campaign link is ${arrival.status}`);
  const opened = await anon.ok<{ participantToken: string; sessionId: string }>(
    "POST",
    `/p/${linkToken}/open`,
    {},
  );
  result.sessionId = opened.sessionId;
  result.participantToken = opened.participantToken;
  const api = new Api(actor, `pt.${opened.participantToken}`);

  await api.ok("POST", "/p/session/consent", {
    consentVersion: arrival.campaign.consentVersion ?? "v1",
    participantFields: { name: persona.name, role: persona.role, department: persona.department },
    participationChoice: persona.participation,
  });

  const system = simulatorSystemPrompt(persona);
  const history: Exchange[] = [];
  let input: TurnInput | undefined; // first turn: empty body
  let pressedDone = false;
  let widgetOffers = 0;

  for (let i = 0; i < opts.maxTurns + 4; i++) {
    if (abortState.reason) throw new Error(abortState.reason);
    let outcome: TurnOutcome | undefined;
    let retried = 0;
    for (;;) {
      outcome = await api.turn("/p/session/turns", input);
      const failed = outcome.error !== null || outcome.status !== 200 || outcome.message === null;
      if (!failed) break;
      if (outcome.error?.code === "budget_exceeded" || retried >= MAX_RETRIES) break;
      retried += 1;
      notes.push(
        `turn ${i}: ${outcome.error?.code ?? outcome.status} (${outcome.error?.message ?? ""}), retry ${retried}`,
      );
      await sleep(3000 * retried);
    }
    const message: TurnMessage | null = outcome.message;
    const record: TurnRecord = {
      index: i,
      assistantText: message?.content ?? outcome.text,
      widget: message?.widget ?? null,
      areaKey: message?.areaKey ?? null,
      firstTokenMs: outcome.firstTokenMs,
      totalMs: outcome.totalMs,
      reply: null,
      error: outcome.error,
      retried,
    };
    result.turns.push(record);
    if (outcome.progress) result.areas = outcome.progress.areas;
    if (outcome.error || !message) {
      result.endReason = `turn failed: ${outcome.error?.code ?? outcome.status}`;
      break;
    }
    history.push({ role: "assistant", content: message.content });
    if (outcome.ended) {
      result.ended = true;
      result.endReason = "engine ended the interview";
      break;
    }

    // The participant decides whether to say "I'm done" instead of answering.
    const wantsOut =
      (persona.finishAfterTurns !== undefined && i + 1 >= persona.finishAfterTurns) || i + 1 >= opts.maxTurns;
    if (wantsOut && !pressedDone) {
      pressedDone = true;
      await api.ok("POST", "/p/session/complete");
      notes.push(`pressed "I'm done" after ${i + 1} assistant turns`);
    }

    // Answer: by widget when the persona's policy says so, otherwise in words.
    const widget = message.widget ?? null;
    let answered = false;
    if (widget) {
      widgetOffers += 1;
      const use = persona.widgets === "always" || (persona.widgets === "sometimes" && widgetOffers % 2 === 1);
      if (use) {
        const wr = await simulateWidget(sim, system, history, widget, `sim:${persona.id}`);
        if (wr) {
          input = widgetInput(wr);
          const shown = JSON.stringify(wr);
          history.push({ role: "user", content: `(I picked: ${shown})` });
          record.reply = { modality: "widget", text: shown };
          answered = true;
        }
      }
    }
    if (!answered) {
      const text = await simulateReply(sim, system, history, `sim:${persona.id}`);
      input = { content: text, modality: "text" };
      history.push({ role: "user", content: text });
      record.reply = { modality: "text", text };
    }
  }
  if (!result.ended && !result.endReason) result.endReason = "turn cap reached";

  // The participant reviews and edits the end-of-session summary (FR: participant-editable).
  try {
    const first = await api.call<{ summary: string; facts: FactRecord[] }>("GET", "/p/session/summary");
    if (first.status === 200) {
      result.summary = first.body.summary;
      if (persona.id === "support_lead" && first.body.summary) {
        const edited = `${first.body.summary}\n\nAddition from me: the weekly report takes me closer to four hours than three.`;
        const put = await api.call("PUT", "/p/session/summary", { summary: edited });
        const again = await api.call<{ summary: string }>("GET", "/p/session/summary");
        result.summaryEdited = put.status === 200 && again.body.summary === edited;
        if (!result.summaryEdited) notes.push(`summary edit did not persist (PUT ${put.status})`);
      }
    } else {
      notes.push(`GET /p/session/summary returned ${first.status}`);
    }
  } catch (err) {
    notes.push(`summary fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  result.finishedAt = Date.now();
  log(
    `interview ${persona.id}: ${result.turns.length} turns, ${result.ended ? "ended" : "NOT ended"} (${result.endReason})`,
  );
  return result;
}

/** Facts and areas as the participant sees them, polled until extraction has settled. */
export async function collectFacts(r: InterviewResult, waitMs: number): Promise<void> {
  const api = new Api(`participant:${r.persona.id}`, `pt.${r.participantToken}`);
  const deadline = Date.now() + waitMs;
  let lastCount = -1;
  let stableSince = Date.now();
  for (;;) {
    const res = await api.call<{ summary: string; facts: FactRecord[] }>("GET", "/p/session/summary");
    if (res.status === 200) {
      r.facts = res.body.facts;
      if (!r.summaryEdited) r.summary = res.body.summary;
      if (res.body.facts.length !== lastCount) {
        lastCount = res.body.facts.length;
        stableSince = Date.now();
      }
    }
    if (Date.now() >= deadline) return;
    if (lastCount > 0 && Date.now() - stableSince > 15_000) return;
    await sleep(5000);
  }
}

export function transcriptMarkdown(r: InterviewResult): string {
  const lines = [
    `# ${r.persona.id} (${r.persona.role}, ${r.persona.participation})`,
    "",
    `session ${r.sessionId}; ${r.turns.length} assistant turns; ${r.endReason}`,
    "",
  ];
  for (const t of r.turns) {
    lines.push(`**Interviewer${t.areaKey ? ` [${t.areaKey}]` : ""}:** ${t.assistantText}`);
    if (t.widget) lines.push(`  _(widget: ${t.widget.type})_`);
    if (t.error) lines.push(`  _(error: ${t.error.code}: ${t.error.message})_`);
    if (t.reply) lines.push("", `**${r.persona.name} (${t.reply.modality}):** ${t.reply.text}`);
    lines.push("");
  }
  return lines.join("\n");
}

export interface DoneProbeResult {
  sessionId: string;
  completeStatus: number;
  turnAfterComplete: { status: number; ended: boolean; error: string | null; text: string };
  immediateRetry: { status: number; error: string | null };
  deleteStatus: number;
  viewAfterDeleteStatus: number;
}

/**
 * Two canned answers (no model cost), then "I'm done", then a turn. Probes the participant's
 * stop-early path and the delete-my-data path (FR-13) on a session outside the eight personas.
 */
export async function runDoneProbe(linkToken: string): Promise<DoneProbeResult> {
  const anon = new Api("probe", "");
  const arrival = await anon.ok<CampaignView>("GET", `/p/${linkToken}`);
  const opened = await anon.ok<{ participantToken: string; sessionId: string }>(
    "POST",
    `/p/${linkToken}/open`,
    {},
  );
  const api = new Api("probe", `pt.${opened.participantToken}`);
  await api.ok("POST", "/p/session/consent", {
    consentVersion: arrival.campaign.consentVersion ?? "v1",
    participantFields: { role: "Ward nurse", department: "Probe" },
    participationChoice: "anonymous",
  });
  await api.turn("/p/session/turns");
  await api.turn("/p/session/turns", { content: "I am a nurse on a cardiology ward.", modality: "text" });
  const done = await api.call("POST", "/p/session/complete");
  const after = await api.turn("/p/session/turns", {
    content: "That is all I wanted to say.",
    modality: "text",
  });
  const retry = await api.turn("/p/session/turns", {
    content: "That is all I wanted to say.",
    modality: "text",
  });
  const del = await api.call("DELETE", "/p/session");
  const view = await api.call("GET", "/p/session");
  return {
    sessionId: opened.sessionId,
    completeStatus: done.status,
    turnAfterComplete: {
      status: after.status,
      ended: after.ended,
      error: after.error ? `${after.error.code}: ${after.error.message}` : null,
      text: after.text.slice(0, 300),
    },
    immediateRetry: {
      status: retry.status,
      error: retry.error ? `${retry.error.code}: ${retry.error.message}` : null,
    },
    deleteStatus: del.status,
    viewAfterDeleteStatus: view.status,
  };
}
