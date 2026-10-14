import type { Api, TurnInput, TurnOutcome, Widget } from "./api.js";
import type { TurnRecord } from "./interview.js";
import { abortState, log, sleep } from "./runtime.js";
import {
  simulateReply,
  simulateWidget,
  widgetInput,
  type Exchange,
  type SimulatorConfig,
} from "./simulator.js";

export interface Handoff {
  sourceOpportunityId: string;
  problem: string;
  affectedUsers: string[];
  existingProcess: string[];
  tools: string[];
  constraints: string;
  expectedBenefit: string;
  evidenceQuotes: string[];
}

export type OwnerKind = "nontechnical" | "technical";

export function ownerSystemPrompt(kind: OwnerKind, topic: string, handoff: Handoff | null): string {
  const who =
    kind === "nontechnical"
      ? "You are Helena, a ward operations manager at a regional hospital group. You own this problem and know the clinical workflow in detail, but you are not technical: you do not know what an API, a database or a queue is, and when asked a technical question you say so and ask the interviewer to recommend an option and explain the consequence in plain words."
      : "You are Aki, a senior software engineer in the hospital group's IT department who has been asked to own this tool. You are comfortable with APIs, data models, authentication (the hospital uses Azure AD single sign-on), HL7 and FHIR, and you give precise technical answers, naming concrete technologies and constraints.";
  return [
    who,
    `You are being interviewed by an AI requirements interviewer so that a software specification can be written for: ${topic}.`,
    handoff
      ? `What is already known from the discovery research:\n- Problem: ${handoff.problem}\n- Affected users: ${handoff.affectedUsers.join(", ") || "not stated"}\n- Existing process: ${handoff.existingProcess.join("; ") || "not stated"}\n- Tools today: ${handoff.tools.join(", ") || "not stated"}\n- Constraints: ${handoff.constraints || "not stated"}\n- Expected benefit: ${handoff.expectedBenefit || "not stated"}`
      : "You have only the one-paragraph idea described above; fill in realistic details as questions reach them.",
    "Rules:",
    "- Answer the question asked, in the first person, in two to five sentences. Make concrete decisions with specific numbers, names and rules, consistent with what you said before.",
    "- When the interviewer proposes a default or a recommendation and it sounds reasonable, accept it; sometimes (about one answer in four) choose differently and say why.",
    "- If you are told something is ambiguous or contradictory, resolve it with a clear decision.",
    "- Never say you are an AI. No stage directions, no quotation marks.",
  ].join("\n");
}

export interface RequirementsRun {
  sessionId: string;
  kind: OwnerKind;
  turns: TurnRecord[];
  ended: boolean;
  endReason: string;
  progress: { key: string; name: string; status: string }[];
  notes: string[];
  specEvents: number;
}

export async function runRequirementsTurns(opts: {
  api: Api;
  sessionId: string;
  kind: OwnerKind;
  system: string;
  sim: SimulatorConfig;
  maxTurns: number;
  /** Extra instruction given to the owner for these turns only (used after a reopen). */
  nudge?: string;
  /** Turn index to start numbering from, so a reopened run continues the earlier one. */
  startIndex?: number;
  firstInput?: TurnInput | undefined;
  label: string;
}): Promise<RequirementsRun> {
  const { api, sessionId } = opts;
  const run: RequirementsRun = {
    sessionId,
    kind: opts.kind,
    turns: [],
    ended: false,
    endReason: "",
    progress: [],
    notes: [],
    specEvents: 0,
  };
  const history: Exchange[] = [];
  let input: TurnInput | undefined = opts.firstInput;
  let pressedDone = false;
  let widgetOffers = 0;

  for (let i = 0; i < opts.maxTurns + 5; i++) {
    if (abortState.reason) throw new Error(abortState.reason);
    let outcome: TurnOutcome;
    let retried = 0;
    for (;;) {
      outcome = await api.turn(`/requirements/${sessionId}/turns`, input);
      const failed = outcome.error !== null || outcome.status !== 200 || outcome.message === null;
      if (!failed || outcome.error?.code === "budget_exceeded" || retried >= 2) break;
      retried += 1;
      run.notes.push(`turn ${i}: ${outcome.error?.code ?? outcome.status}; retry ${retried}`);
      await sleep(3000 * retried);
    }
    if (outcome.spec) run.specEvents += 1;
    const message = outcome.message;
    const record: TurnRecord = {
      index: (opts.startIndex ?? 0) + i,
      assistantText: message?.content ?? outcome.text,
      widget: message?.widget ?? null,
      areaKey: message?.areaKey ?? null,
      firstTokenMs: outcome.firstTokenMs,
      totalMs: outcome.totalMs,
      reply: null,
      error: outcome.error,
      retried,
    };
    run.turns.push(record);
    if (outcome.progress) run.progress = outcome.progress.areas;
    if (outcome.error || !message) {
      run.endReason = `turn failed: ${outcome.error?.code ?? outcome.status}`;
      break;
    }
    history.push({ role: "assistant", content: message.content });
    if (outcome.ended) {
      run.ended = true;
      run.endReason = "engine ended the session";
      break;
    }
    if (i + 1 >= opts.maxTurns && !pressedDone) {
      pressedDone = true;
      await api.ok("POST", `/requirements/${sessionId}/complete`);
      run.notes.push(`pressed complete after ${i + 1} assistant turns`);
    }
    const widget: Widget | null = message.widget ?? null;
    let answered = false;
    if (widget) {
      widgetOffers += 1;
      if (widgetOffers % 2 === 1) {
        const wr = await simulateWidget(opts.sim, opts.system, history, widget, opts.label);
        if (wr) {
          input = widgetInput(wr);
          history.push({ role: "user", content: `(I picked: ${JSON.stringify(wr)})` });
          record.reply = { modality: "widget", text: JSON.stringify(wr) };
          answered = true;
        }
      }
    }
    if (!answered) {
      const text = await simulateReply(opts.sim, opts.system, history, opts.label, opts.nudge);
      input = { content: text, modality: "text" };
      history.push({ role: "user", content: text });
      record.reply = { modality: "text", text };
    }
  }
  if (!run.ended && !run.endReason) run.endReason = "turn cap reached";
  log(
    `requirements ${opts.kind}: ${run.turns.length} turns, ${run.ended ? "ended" : "NOT ended"} (${run.endReason})`,
  );
  return run;
}

export interface RequirementsProbeResult {
  sessionId: string;
  completeStatus: number;
  turnAfterComplete: { status: number; error: string | null };
  viewStatus: number;
  viewError: string | null;
}

/** Two cheap turns, then the owner's "I'm done", then a turn and a read of the session. */
export async function runRequirementsDoneProbe(api: Api): Promise<RequirementsProbeResult> {
  const created = await api.ok<{ session: { id: string } }>("POST", "/requirements", {
    title: "Probe: owner presses done early",
    prompt: "A small tool that lets a ward clerk record bed status once instead of three times.",
    path: "nontechnical",
  });
  const id = created.session.id;
  await api.turn(`/requirements/${id}/turns`);
  await api.turn(`/requirements/${id}/turns`, {
    content: "The ward clerk would use it, about 10 people across 3 wards.",
    modality: "text",
  });
  const done = await api.call("POST", `/requirements/${id}/complete`);
  const after = await api.turn(`/requirements/${id}/turns`, {
    content: "That is everything for now.",
    modality: "text",
  });
  const view = await api.call<{ error?: { message?: string } }>("GET", `/requirements/${id}`);
  return {
    sessionId: id,
    completeStatus: done.status,
    turnAfterComplete: {
      status: after.status,
      error: after.error ? `${after.error.code}: ${after.error.message}` : null,
    },
    viewStatus: view.status,
    viewError: view.status >= 400 ? JSON.stringify(view.body).slice(0, 200) : null,
  };
}

export interface VersionSummary {
  id: string;
  version: number;
  status: string;
  error?: string;
  stats: Record<string, unknown>;
}

/** Queues a version and polls until the worker has finished it. */
export async function generateVersion(
  api: Api,
  sessionId: string,
  label: string,
  timeoutMs: number,
): Promise<VersionSummary> {
  const queued = await api.ok<{ version: VersionSummary }>("POST", `/requirements/${sessionId}/versions`, {
    label,
  });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await api.ok<{ versions: VersionSummary[] }>("GET", `/requirements/${sessionId}/versions`);
    const v = list.versions.find((x) => x.version === queued.version.version);
    if (v && (v.status === "done" || v.status === "failed")) return v;
    if (Date.now() > deadline)
      throw new Error(
        `version ${queued.version.version} still ${v?.status ?? "missing"} after ${timeoutMs} ms`,
      );
    await sleep(5000);
  }
}
