import type { TurnInput, Widget, WidgetResponse } from "./api.js";
import { extractJson } from "./pure.js";
import { chat, type ChatEndpoint, type ChatMessage } from "./runtime.js";

export interface SimulatorConfig {
  apiKey: string;
  model: string;
  /** Another Chat Completions endpoint than OpenRouter's (see `backend.ts`). */
  endpoint?: ChatEndpoint;
}

export interface Exchange {
  role: "assistant" | "user";
  content: string;
}

/**
 * The simulated person: a separate cheap model call made straight to OpenRouter, outside the
 * product, so it never touches the product's ledger or routes.
 */
export async function simulateReply(
  cfg: SimulatorConfig,
  system: string,
  history: Exchange[],
  label: string,
  /** A last instruction appended to the conversation, such as "answer in two words". */
  nudge?: string,
): Promise<string> {
  // The roles are mirrored: from the simulator's side the interviewer is the "user".
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...history.map((h) => ({
      role: h.role === "assistant" ? ("user" as const) : ("assistant" as const),
      content: h.content,
    })),
  ];
  if (nudge) messages.push({ role: "system", content: nudge });
  const r = await chat({
    apiKey: cfg.apiKey,
    model: cfg.model,
    label,
    messages,
    maxTokens: 350,
    temperature: 0.9,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
  });
  return r.content.trim().replace(/^["“]|["”]$/g, "") || "I am not sure.";
}

function describeWidget(w: Widget): string {
  switch (w.type) {
    case "single_choice":
      return `Pick exactly one: ${w.options.map((o) => `"${o.key}" (${o.label})`).join(", ")}. Reply {"choice": "<key>"}.`;
    case "multi_choice":
      return `Pick one or more: ${w.options.map((o) => `"${o.key}" (${o.label})`).join(", ")}. Reply {"choices": ["<key>", ...]}.`;
    case "scale":
      return `Rate from 1 (${w.minLabel}) to 5 (${w.maxLabel}). Reply {"value": <1-5>}.`;
    case "ranking":
      return `Rank these from most to least important: ${w.options.map((o) => `"${o.key}" (${o.label})`).join(", ")}. Reply {"order": ["<key>", ...]}.`;
    case "yes_no":
      return `Answer yes or no. Reply {"value": true} or {"value": false}.`;
  }
}

/** Chooses a widget answer in character. Returns null when the model's answer cannot be mapped. */
export async function simulateWidget(
  cfg: SimulatorConfig,
  system: string,
  history: Exchange[],
  widget: Widget,
  label: string,
): Promise<WidgetResponse | null> {
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...history.map((h) => ({
      role: h.role === "assistant" ? ("user" as const) : ("assistant" as const),
      content: h.content,
    })),
    {
      role: "system",
      content: `The interviewer's last message came with answer options. ${describeWidget(widget)} Output only the JSON object.`,
    },
  ];
  const r = await chat({
    apiKey: cfg.apiKey,
    model: cfg.model,
    label,
    messages,
    maxTokens: 120,
    json: true,
    temperature: 0.6,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
  });
  const parsed = extractJson(r.content) as Record<string, unknown> | null;
  if (!parsed) return null;
  const keysOf = (w: Widget): string[] => ("options" in w ? w.options.map((o) => o.key) : []);
  const valid = keysOf(widget);
  switch (widget.type) {
    case "single_choice": {
      const c = typeof parsed.choice === "string" ? parsed.choice : "";
      return valid.includes(c) ? { type: "single_choice", key: c } : null;
    }
    case "multi_choice": {
      const raw = Array.isArray(parsed.choices) ? parsed.choices.map(String) : [];
      const keys = raw.filter((k) => valid.includes(k)).slice(0, widget.max ?? 10);
      return keys.length ? { type: "multi_choice", keys } : null;
    }
    case "scale": {
      const v = Math.round(Number(parsed.value));
      return v >= 1 && v <= 5 ? { type: "scale", value: v } : null;
    }
    case "ranking": {
      const raw = Array.isArray(parsed.order) ? parsed.order.map(String) : [];
      const keys = raw.filter((k) => valid.includes(k));
      return keys.length === valid.length ? { type: "ranking", keys } : null;
    }
    case "yes_no":
      return typeof parsed.value === "boolean" ? { type: "yes_no", value: parsed.value } : null;
  }
}

/** Wraps a widget answer in the request body the turn route expects. */
export function widgetInput(response: WidgetResponse): TurnInput {
  return { content: "", modality: "widget", widgetResponse: response };
}
