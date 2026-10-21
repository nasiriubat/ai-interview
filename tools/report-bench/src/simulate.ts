import { Client } from "./client.js";
import { abortState, chat, log, sleep, type ChatMessage } from "./openrouter.js";
import { personaSystemPrompt, type Persona, type Scenario } from "./scenario.js";

/** One interviewer message and the persona's answer to it (null when the interview ended there). */
export interface Exchange {
  interviewer: string;
  reply: string | null;
}

/** A finished (or capped) interview as the participant saw it. This is what the cache holds. */
export interface Transcript {
  personaId: string;
  sessionId: string;
  ended: boolean;
  endReason: string;
  exchanges: Exchange[];
}

export interface SimulatorConfig {
  apiKey: string;
  model: string;
  temperature: number;
  seed: number;
  /** Stop answering and press "I'm done" after this many interviewer turns. */
  turnCap: number;
}

/** Stable small integer from a string, so every persona and turn has its own reproducible seed. */
export function seedFor(base: number, ...parts: (string | number)[]): number {
  let h = 2166136261 ^ base;
  for (const ch of parts.join("|")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2_147_483_647;
}

/** Strips what a chat model sometimes wraps around a spoken answer. */
export function cleanReply(text: string): string {
  const t = text
    .trim()
    .replace(/^["“”']+|["“”']+$/g, "")
    .replace(/^\*\*?[^*:]{1,40}:\*\*?\s*/, "")
    .trim();
  return t || "I am not sure.";
}

interface Arrival {
  campaign: { consentVersion?: string };
  status: string;
}

/**
 * Runs one persona through the public participant API: arrival, open, consent, then one answer per
 * interviewer message until the engine ends the interview or the turn cap presses "I'm done".
 * The participant token lives only in this function; it is never written to the cache.
 */
export async function simulateInterview(
  base: string,
  linkToken: string,
  scenario: Scenario,
  persona: Persona,
  cfg: SimulatorConfig,
): Promise<Transcript> {
  const anon = new Client(base);
  const arrival = await anon.ok<Arrival>("GET", `/p/${linkToken}`);
  if (arrival.status !== "open") throw new Error(`campaign link is ${arrival.status}`);
  const opened = await anon.ok<{ participantToken: string; sessionId: string }>(
    "POST",
    `/p/${linkToken}/open`,
    {},
  );
  const api = new Client(base, `pt.${opened.participantToken}`);
  await api.ok("POST", "/p/session/consent", {
    consentVersion: arrival.campaign.consentVersion ?? "v1",
    participantFields: { name: persona.name, role: persona.role, department: persona.department },
    participationChoice: persona.participation,
  });

  const system = personaSystemPrompt(scenario, persona);
  const t: Transcript = {
    personaId: persona.id,
    sessionId: opened.sessionId,
    ended: false,
    endReason: "",
    exchanges: [],
  };
  let input: { content: string; modality: "text" } | undefined;
  let pressedDone = false;
  for (let i = 0; i < cfg.turnCap + 4; i++) {
    if (abortState.reason) {
      t.endReason = `aborted: ${abortState.reason}`;
      break;
    }
    let outcome = await api.turn("/p/session/turns", input);
    for (let retry = 1; retry <= 2 && (outcome.error || !outcome.message); retry++) {
      if (outcome.error?.code === "budget_exceeded") break;
      log(`${persona.id} turn ${i}: ${outcome.error?.code ?? outcome.status}, retry ${retry}`);
      await sleep(3000 * retry);
      outcome = await api.turn("/p/session/turns", input);
    }
    if (outcome.error || !outcome.message) {
      t.endReason =
        `turn failed: ${outcome.error?.code ?? outcome.status} ${outcome.error?.message ?? ""}`.trim();
      break;
    }
    const exchange: Exchange = { interviewer: outcome.message.content, reply: null };
    t.exchanges.push(exchange);
    if (outcome.ended) {
      t.ended = true;
      t.endReason = "engine ended the interview";
      break;
    }
    if (i + 1 >= cfg.turnCap && !pressedDone) {
      pressedDone = true;
      await api.ok("POST", "/p/session/complete");
    }
    const options = outcome.message.widget?.options?.map((o) => o.label) ?? [];
    const messages: ChatMessage[] = [{ role: "system", content: system }];
    // Mirrored roles: from the persona's side the interviewer is the "user".
    for (const e of t.exchanges) {
      messages.push({ role: "user", content: e.interviewer });
      if (e.reply !== null) messages.push({ role: "assistant", content: e.reply });
    }
    if (options.length)
      messages.push({
        role: "system",
        content: `The interviewer offered these options: ${options.join("; ")}.`,
      });
    const reply = cleanReply(
      await chat({
        apiKey: cfg.apiKey,
        model: cfg.model,
        label: `sim:${persona.id}`,
        messages,
        maxTokens: 400,
        temperature: cfg.temperature,
        seed: seedFor(cfg.seed, persona.id, i),
      }),
    );
    exchange.reply = reply;
    input = { content: reply, modality: "text" };
  }
  if (!t.endReason) t.endReason = pressedDone ? "turn cap reached" : "loop cap reached";
  log(`${persona.id}: ${t.exchanges.length} interviewer turns, ${t.endReason}`);
  return t;
}

/** The participant's own words, the only text a report quote may come from. */
export function participantText(t: Transcript): string[] {
  return t.exchanges.flatMap((e) => (e.reply ? [e.reply] : []));
}

/** A readable transcript for the judge and for people, labelled by persona id, never by name. */
export function transcriptText(t: Transcript, label: string): string {
  const lines = [`### ${label}`];
  for (const e of t.exchanges) {
    lines.push(`Interviewer: ${e.interviewer}`);
    if (e.reply) lines.push(`Participant: ${e.reply}`);
  }
  return lines.join("\n");
}
