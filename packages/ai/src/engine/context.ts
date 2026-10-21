import type { ChatMessage, InterviewTemplate, SessionState } from "@aidp/shared";
import { widgetResponseToText } from "@aidp/shared";
import { estimateTokens } from "../cost/pricing.js";
import { nextRequirementNumber } from "../spec/delta-validation.js";
import { mvpItems, requirementFacts, specFacts, titleOf } from "../spec/live.js";
import { languageName } from "../util/language.js";
import { newNonce, wrapUntrusted } from "../util/untrusted.js";
import type { EngineSettings, SessionSnapshot, StoredMessage } from "./ports.js";
import type { PromptDefinition } from "./prompts/index.js";
import { NO_CAPTURE_INSTRUCTIONS, SPEC_CAPTURE_INSTRUCTIONS } from "./prompts/interviewer.v7.js";
import type { Focus } from "./selection.js";
import { TURN_MARKER } from "./turn-parser.js";

/** The last line of every interviewer request (see `assembleContext`). */
export const FORMAT_REMINDER = `Reply format: your message to the participant, then a line containing exactly ${TURN_MARKER}, then the JSON metadata object. Earlier interviewer messages above are shown without their metadata; yours must include it.`;

export interface AssembledContext {
  system: string;
  messages: ChatMessage[];
  tokensEstimate: number;
  recentTurnsIncluded: number;
}

/** Layer 1: the stable prefix. Depends only on the template and prompt version, so it caches. */
export function renderSystemPrompt(prompt: PromptDefinition, template: InterviewTemplate): string {
  const areas = template.coverageAreas
    .map(
      (a, i) =>
        `${i + 1}. ${a.key}: ${a.name}. ${a.description} Covered when: ${a.doneWhen}${a.instructions ? ` Instructions: ${a.instructions}` : ""}`,
    )
    .join("\n");
  return prompt.body
    .replace("{{objective}}", template.objective)
    .replace("{{language}}", languageName(template.language))
    .replace("{{aiInstructions}}", template.aiInstructions || "(none)")
    .replace("{{areas}}", areas)
    .replace("{{widgetTypes}}", template.widgetPolicy.allowedTypes.join(", ") || "none")
    .replace("{{maxChars}}", String(template.maxAssistantChars))
    .replace(
      "{{outputInstructions}}",
      template.outputs.includes("spec_field") ? SPEC_CAPTURE_INSTRUCTIONS : NO_CAPTURE_INSTRUCTIONS,
    );
}

/** Layer 2: structured state rendered compactly. */
export function renderState(
  state: SessionState,
  template: InterviewTemplate,
  path?: string,
  handoff?: SessionSnapshot["handoff"],
  attachments?: SessionSnapshot["attachments"],
): string {
  const lines: string[] = [];
  if (path) lines.push(`Path: ${path}`);
  const p = state.profile;
  const profile = [
    p.role && `role=${p.role}`,
    p.department && `department=${p.department}`,
    p.seniority && `seniority=${p.seniority}`,
    p.prefersShortAnswers && "prefers short answers",
    p.notes,
  ]
    .filter(Boolean)
    .join("; ");
  if (profile) lines.push(`Participant: ${profile}`);
  // Every turn, so the interviewer can refer to a file the participant shared and ask about what
  // is in it. Only the summary rides along; the wording is retrieved on demand, because a long
  // document in the prompt on every turn is the most expensive mistake available here.
  if (attachments && attachments.length > 0) {
    lines.push("Files the participant attached:");
    for (const a of attachments) {
      if (a.status === "pending") lines.push(`- ${a.filename} (still being read)`);
      else if (a.status === "failed")
        lines.push(`- ${a.filename} (could not be read; ask them what is in it)`);
      else lines.push(`- ${a.filename}: ${a.summary}`);
    }
    lines.push(
      "Refer to these when relevant. Ask about what they show rather than asking for facts they already contain.",
    );
  }
  if (handoff) {
    lines.push("Hand-off from discovery (already known; confirm, do not re-ask):");
    lines.push(`- problem: ${handoff.problem}`);
    if (handoff.affectedUsers.length) lines.push(`- affected users: ${handoff.affectedUsers.join(", ")}`);
    if (handoff.existingProcess.length)
      lines.push(`- existing process: ${handoff.existingProcess.join(" → ")}`);
    if (handoff.tools.length) lines.push(`- tools: ${handoff.tools.join(", ")}`);
    if (handoff.constraints) lines.push(`- constraints: ${handoff.constraints}`);
    if (handoff.expectedBenefit) lines.push(`- expected benefit: ${handoff.expectedBenefit}`);
    // The brief describes the problem, not the product: read as "already known", it made the
    // interviewer skip capture, and one simulated hand-off ended with one requirement after 16
    // turns where an idea interview had 22 (simulation 2026-10-15).
    if (template.outputs.includes("spec_field"))
      lines.push(
        "This brief is background, not the requirements list: none of it is recorded yet. Ask what the product must do about it, and record each capability the owner states or confirms as its own functional requirement in that turn.",
      );
  }
  if (Object.keys(state.contextAnswers).length) {
    lines.push("Context answers:");
    for (const [k, v] of Object.entries(state.contextAnswers)) lines.push(`- ${k}: ${v}`);
  }
  lines.push("Coverage:");
  for (const a of template.coverageAreas) {
    const c = state.coverage[a.key];
    const status = c?.status ?? "untouched";
    const detail =
      c && (c.known || c.missing) ? ` known: ${c.known || "-"} | missing: ${c.missing || "-"}` : "";
    lines.push(`- ${a.key}: ${status}${detail}`);
  }
  const open = state.openThreads.filter((t) => !t.resolved);
  if (open.length) {
    lines.push("Open threads:");
    for (const t of open) lines.push(`- [${t.id}] (${t.areaKey}, p${t.priority}) ${t.topic}`);
  }
  if (state.decisions.length) {
    lines.push("Decisions:");
    for (const d of state.decisions.slice(-20)) lines.push(`- ${d.key}: ${d.choice} (${d.source})`);
  }
  const spec = specFacts(state);
  if (spec.length) {
    lines.push("Specification so far (section: paths):");
    const bySection = new Map<string, string[]>();
    for (const f of spec) bySection.set(f.sectionKey, [...(bySection.get(f.sectionKey) ?? []), f.path]);
    for (const [k, paths] of bySection) lines.push(`- ${k}: ${paths.slice(-12).join(", ")}`);
    const requirements = specFacts(state).filter((f) => /^FR-\d+$/.test(f.path)).length;
    lines.push(
      `Functional requirements recorded: ${requirements}; the next one is FR-${nextRequirementNumber(state)}`,
    );
    // Titles, not just ids: a capability the interviewer cannot see is a capability it files twice.
    const recorded = requirementFacts(state);
    if (recorded.length) {
      lines.push("Requirements recorded (re-record an id to change it; never file one twice):");
      for (const f of recorded.slice(-40))
        lines.push(`- ${f.path}: ${titleOf(f.value, f.path).replace(/\s+/g, " ").slice(0, 90)}`);
      if (recorded.length > 40) lines.push(`(${recorded.length - 40} earlier requirements not shown)`);
    }
    const mvp = mvpItems(state);
    if (mvp.length) lines.push(`MVP items: ${mvp.map((i) => `${i.path} ${i.title}`).join("; ")}`);
  }
  const others = state.facts.filter((f) => f.kind !== "spec_field");
  if (others.length) {
    const byKind = new Map<string, number>();
    for (const f of others) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
    lines.push(`Facts so far: ${[...byKind].map(([k, n]) => `${k}=${n}`).join(", ")}`);
  }
  const findings = state.findings.filter((f) => f.status === "open" || f.status === "raised");
  if (findings.length) {
    lines.push("Findings in play:");
    for (const f of findings)
      lines.push(
        `- [${f.id}] ${f.type} at ${f.section}${f.path ? `/${f.path}` : ""} (${f.status}): ${f.description}`,
      );
  }
  if (state.shortened)
    lines.push("Note: the participant gives minimal answers; the interview is shortened to essential areas.");
  return lines.join("\n");
}

export function renderFocus(
  focus: Focus,
  template: InterviewTemplate,
  path?: string,
  state?: SessionState,
): string {
  const pending = state?.findings.find((f) => f.status === "raised" && f.raisedTurn === state.turnCount);
  const prefix = pending
    ? `The participant has just answered finding [${pending.id}] (${pending.description}). Record the outcome in stateDelta.findingOutcomes first. `
    : "";
  return prefix + renderFocusBody(focus, template, path, state);
}

function renderFocusBody(
  focus: Focus,
  template: InterviewTemplate,
  path?: string,
  state?: SessionState,
): string {
  switch (focus.mode) {
    case "context": {
      const q = template.contextBlock.find((c) => c.key === focus.questionKey);
      if (!q) return "Engine focus: ask the next context question.";
      const text = path === "nontechnical" && q.questionNontechnical ? q.questionNontechnical : q.question;
      const opts = q.options
        ? ` Offer a single_choice widget with options: ${q.options.map((o) => `${o.key}=${o.label}`).join(", ")}.`
        : "";
      const dflt = q.default ? ` Default if unsure: ${q.default}.` : "";
      const asked = state?.contextAsks[q.key] ?? 0;
      const again =
        asked > 0
          ? ` This question was already asked ${asked === 1 ? "once" : `${asked} times`}: if the participant has answered it in any form, do not ask again; write the answer (or the default) into stateDelta.contextAnswers["${q.key}"] now and move on.`
          : "";
      return `Engine focus: context question "${q.key}". Ask: ${text}${q.why ? ` Say briefly why it matters: ${q.why}` : ""}${dflt}${opts} Record the answer in stateDelta.contextAnswers["${q.key}"]. Set areaKey to "context".${again}`;
    }
    case "continue":
      return `Engine focus: stay on area "${focus.areaKey}". If the last answer was ambiguous, clarify; otherwise go one level deeper with a concrete example. Set areaKey to "${focus.areaKey}".`;
    case "thread":
      return `Engine focus: pick up the open thread [${focus.threadId}] "${focus.topic}" in area "${focus.areaKey}". Resolve it in stateDelta.resolvedThreadIds. Set areaKey to "${focus.areaKey}".`;
    case "area":
      return `Engine focus: open area "${focus.areaKey}" with one natural, easy first question. Set areaKey to "${focus.areaKey}".`;
    case "finding": {
      const f = state?.findings.find((x) => x.id === focus.findingId);
      if (!f) return `Engine focus: raise finding [${focus.findingId}]. Set areaKey to "finding".`;
      const where = `${f.section}${f.path ? `/${f.path}` : ""}`;
      if (focus.pushBack)
        return `Engine focus: the participant rejected finding [${f.id}] (${f.type} at ${where}: ${f.description}). Push back once: state the concrete consequence of leaving it as is, in one or two sentences, then ask whether they want to keep it that way. Whatever they answer next is final. Set areaKey to "finding".`;
      return `Engine focus: raise finding [${f.id}], a ${f.type.replace("_", " ")} at ${where}: ${f.description} Propose: ${f.resolution} Default: ${f.default}. Phrase it for the ${path ?? "participant's"} path, one question, and offer the default. Set areaKey to "finding".`;
    }
    case "mvp_challenge":
      return `Engine focus: MVP challenge for ${focus.itemPath} "${focus.title}". Ask, in your own words: if version one shipped without this, what breaks? Explain in one sentence that this keeps version one small. Set areaKey to "mvp_challenge".`;
    case "closing":
      return `Engine focus: ask the closing question: "${template.closingQuestion}". Set areaKey to "closing".`;
    case "summary":
      return `Engine focus: thank the participant and give a short summary (under 120 words) of what you captured, written to them without a name unless they gave you theirs, and invite corrections. Set areaKey to "summary" and endInterview to true.`;
    case "done":
      return "Engine focus: the interview is complete.";
  }
}

export function renderStoredMessage(m: StoredMessage): string {
  if (m.role === "user" && m.widgetResponse && m.widget) {
    const text = widgetResponseToText(m.widget, m.widgetResponse);
    return m.content && m.content !== text ? `${text}. ${m.content}` : text;
  }
  return m.content;
}

/**
 * Builds the messages for one turn within the token budget. Order:
 * [user: session context + summary + recalled snippets] [assistant: ack] [recent turns...] [user: last answer + focus]
 */
export function assembleContext(input: {
  prompt: PromptDefinition;
  session: SessionSnapshot;
  focus: Focus;
  recent: StoredMessage[]; // oldest first, may include the just-persisted user message
  recalled: { seq: number; text: string }[];
  settings: EngineSettings;
  /** Delimiter nonce for this assembly; random when omitted, fixed by tests that compare text. */
  nonce?: string;
}): AssembledContext {
  const { session, focus, settings } = input;
  const system = renderSystemPrompt(input.prompt, session.template);
  const nonce = input.nonce ?? newNonce();
  const budget = settings.inputTokenBudget;
  let used = estimateTokens(system);

  // Everything below came from a participant, a file, or an earlier model turn, however it is
  // phrased: it is data. Each piece goes into its own nonce-delimited block (security plan P12) and
  // the system prompt says what such a block is. The engine focus stays outside every block.
  const contextParts = [
    "Session context",
    wrapUntrusted(
      "session_state",
      renderState(session.state, session.template, session.path, session.handoff, session.attachments),
      { nonce },
    ),
  ];
  if (session.summary)
    contextParts.push(
      "",
      "Summary of the conversation so far",
      wrapUntrusted("summary", session.summary, { nonce }),
    );
  let recalled = input.recalled;
  const contextText = () =>
    [
      ...contextParts,
      ...(recalled.length
        ? [
            "",
            "Recalled earlier turns",
            ...recalled.map((r) =>
              wrapUntrusted("recalled_turn", r.text, { nonce, id: r.seq, maxChars: 1500 }),
            ),
          ]
        : []),
    ].join("\n");
  used += estimateTokens(contextText());
  while (used > budget * 0.6 && recalled.length) {
    recalled = recalled.slice(0, -1);
    used = estimateTokens(system) + estimateTokens(contextText());
  }

  // The interviewer's earlier messages are shown without their metadata block, so a model that
  // imitates its history stops writing one (about half the replies of a cheap model in the live
  // run of 2026-10-14). The reminder sits last, next to the question, where it is followed.
  const focusText = `<engine_focus>\n${renderFocus(focus, session.template, session.path, session.state)}\n</engine_focus>\n\n${FORMAT_REMINDER}`;
  used += estimateTokens(focusText);

  // Recent window: newest first until the budget is spent, then restore order.
  const window: StoredMessage[] = [];
  const candidates = input.recent.slice(-settings.recentWindowTurns * 2);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const m = candidates[i];
    if (!m) continue;
    const cost = estimateTokens(renderStoredMessage(m));
    if (used + cost > budget && window.length > 0) break;
    used += cost;
    window.unshift(m);
  }

  const messages: ChatMessage[] = [
    { role: "user", content: `${contextText()}\n\n(The conversation follows. Continue it naturally.)` },
    {
      role: "assistant",
      content: "Understood. I have the session context and will follow the engine focus.",
    },
  ];
  // A participant's turns are delimited; the interviewer's own earlier turns keep the assistant
  // role, which a participant cannot write, and stay as they are so the model does not learn to
  // emit delimiters itself.
  for (const m of window)
    messages.push({
      role: m.role,
      content:
        m.role === "user"
          ? wrapUntrusted("participant_turn", renderStoredMessage(m), { nonce, id: m.seq })
          : renderStoredMessage(m),
    });

  // Attach the focus to the last user message, or add a user message to keep alternation.
  const last = messages[messages.length - 1];
  if (last?.role === "user" && typeof last.content === "string" && window.length > 0) {
    last.content = `${last.content}\n\n${focusText}`;
  } else {
    messages.push({
      role: "user",
      content: window.length ? focusText : `(No answer yet. Begin the interview.)\n\n${focusText}`,
    });
  }
  return {
    system,
    messages: mergeAlternating(messages),
    tokensEstimate: used,
    recentTurnsIncluded: window.length,
  };
}

/** Providers require alternating roles; merge consecutive same-role messages. */
function mergeAlternating(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev?.role === m.role && typeof prev.content === "string" && typeof m.content === "string") {
      prev.content = `${prev.content}\n\n${m.content}`;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}
