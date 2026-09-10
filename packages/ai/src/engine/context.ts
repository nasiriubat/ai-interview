import type { ChatMessage, InterviewTemplate, SessionState } from "@aidp/shared";
import { widgetResponseToText } from "@aidp/shared";
import { estimateTokens } from "../cost/pricing.js";
import type { EngineSettings, SessionSnapshot, StoredMessage } from "./ports.js";
import type { PromptDefinition } from "./prompts/index.js";
import type { Focus } from "./selection.js";

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
    .replace("{{aiInstructions}}", template.aiInstructions || "(none)")
    .replace("{{areas}}", areas)
    .replace("{{widgetTypes}}", template.widgetPolicy.allowedTypes.join(", ") || "none")
    .replace("{{maxChars}}", String(template.maxAssistantChars));
}

/** Layer 2: structured state rendered compactly. */
export function renderState(state: SessionState, template: InterviewTemplate, path?: string): string {
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
  if (state.facts.length) {
    const byKind = new Map<string, number>();
    for (const f of state.facts) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
    lines.push(`Facts so far: ${[...byKind].map(([k, n]) => `${k}=${n}`).join(", ")}`);
  }
  if (state.shortened)
    lines.push("Note: the participant gives minimal answers; the interview is shortened to essential areas.");
  return lines.join("\n");
}

export function renderFocus(focus: Focus, template: InterviewTemplate, path?: string): string {
  switch (focus.mode) {
    case "context": {
      const q = template.contextBlock.find((c) => c.key === focus.questionKey);
      if (!q) return "Engine focus: ask the next context question.";
      const text = path === "nontechnical" && q.questionNontechnical ? q.questionNontechnical : q.question;
      const opts = q.options
        ? ` Offer a single_choice widget with options: ${q.options.map((o) => `${o.key}=${o.label}`).join(", ")}.`
        : "";
      const dflt = q.default ? ` Default if unsure: ${q.default}.` : "";
      return `Engine focus: context question "${q.key}". Ask: ${text}${q.why ? ` Say briefly why it matters: ${q.why}` : ""}${dflt}${opts} Record the answer in stateDelta.contextAnswers["${q.key}"]. Set areaKey to "context".`;
    }
    case "continue":
      return `Engine focus: stay on area "${focus.areaKey}". If the last answer was ambiguous, clarify; otherwise go one level deeper with a concrete example. Set areaKey to "${focus.areaKey}".`;
    case "thread":
      return `Engine focus: pick up the open thread [${focus.threadId}] "${focus.topic}" in area "${focus.areaKey}". Resolve it in stateDelta.resolvedThreadIds. Set areaKey to "${focus.areaKey}".`;
    case "area":
      return `Engine focus: open area "${focus.areaKey}" with one natural, easy first question. Set areaKey to "${focus.areaKey}".`;
    case "closing":
      return `Engine focus: ask the closing question: "${template.closingQuestion}". Set areaKey to "closing".`;
    case "summary":
      return `Engine focus: thank the participant and give a short summary (under 120 words) of what you captured, written to them, and invite corrections. Set areaKey to "summary" and endInterview to true.`;
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
}): AssembledContext {
  const { session, focus, settings } = input;
  const system = renderSystemPrompt(input.prompt, session.template);
  const budget = settings.inputTokenBudget;
  let used = estimateTokens(system);

  const contextParts = ["Session context", renderState(session.state, session.template, session.path)];
  if (session.summary) contextParts.push("", "Summary of the conversation so far", session.summary);
  let recalled = input.recalled;
  const contextText = () =>
    [
      ...contextParts,
      ...(recalled.length
        ? ["", "Recalled earlier turns", ...recalled.map((r) => `- (turn ${r.seq}) ${r.text}`)]
        : []),
    ].join("\n");
  used += estimateTokens(contextText());
  while (used > budget * 0.6 && recalled.length) {
    recalled = recalled.slice(0, -1);
    used = estimateTokens(system) + estimateTokens(contextText());
  }

  const focusText = renderFocus(focus, session.template, session.path);
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
  for (const m of window) messages.push({ role: m.role, content: renderStoredMessage(m) });

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
