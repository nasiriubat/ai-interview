import { contentText, minimalValue, schemaOfRequest, type ChatBody, type Json } from "./schema-gen.js";

/**
 * What the scripted model says.
 *
 * It behaves as an ideal interviewer would, driven by the one thing the engine tells every model
 * the same way: the `<engine_focus>` block at the end of the last message (packages/ai/src/engine/
 * context.ts). Open an area, go one level deeper, ask the closing question, summarize and end. The
 * logic is the one the in-process eval fakes use (evals/src/requirements-model.ts), made stateless
 * so many sessions can share one server: everything it needs is in the request.
 */

export const TURN_MARKER = "<<<TURN_META>>>";

export interface TurnReply {
  text: string;
  meta: Record<string, unknown>;
}

const SPEC_SECTIONS = new Set([
  "overview",
  "users",
  "stories",
  "functional",
  "rules",
  "technical",
  "data",
  "integrations",
  "security",
  "nfr",
  "admin",
  "mvp",
  "future",
  "phases",
  "open_questions",
]);

function lastUserText(body: ChatBody): string {
  const messages = body.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") return contentText(m.content);
  }
  return "";
}

function systemText(body: ChatBody): string {
  return (body.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => contentText(m.content))
    .join("\n");
}

function areaName(system: string, key: string): string {
  const m = new RegExp(`^\\d+\\. ${key}: (.+?)\\.(?: |$)`, "m").exec(system);
  return m?.[1] ?? key.replace(/_/g, " ");
}

/** Whether this request is an interviewer turn: a streamed chat that carries an engine focus. */
export function hasEngineFocus(body: ChatBody): boolean {
  return lastUserText(body).includes("<engine_focus>");
}

export function interviewerTurn(body: ChatBody): TurnReply {
  const last = lastUserText(body);
  const system = systemText(body);
  const focus = /<engine_focus>([\s\S]*?)<\/engine_focus>/.exec(last)?.[1] ?? "";
  const spec = system.includes("Specification capture:");
  const meta: Record<string, unknown> = { reason: "scripted" };
  const delta: Record<string, unknown> = {};
  const facts: unknown[] = [];

  const answeredFinding = /has just answered finding \[([^\]]+)\]/.exec(focus)?.[1];
  if (answeredFinding)
    delta.findingOutcomes = [{ id: answeredFinding, outcome: "resolved", note: "scripted" }];

  const context = /context question "([a-z_0-9]+)"/.exec(focus)?.[1];
  const area = /(?:open|stay on) area "([a-z_0-9]+)"/.exec(focus)?.[1];
  const thread = /open thread \[[^\]]+\] "[^"]*" in area "([a-z_0-9]+)"/.exec(focus)?.[1];
  const finding =
    /raise finding \[([^\]]+)\]/.exec(focus)?.[1] ?? /rejected finding \[([^\]]+)\]/.exec(focus)?.[1];
  const mvp = /MVP challenge for (FR-\d+)/.exec(focus)?.[1];
  const closing = focus.includes("closing question");
  const summary = focus.includes("give a short summary");
  const continuing = focus.includes("stay on area") || thread !== undefined;
  const key = area ?? thread;

  let text: string;
  if (context) {
    meta.areaKey = "context";
    const ask =
      /Ask: (.+?)(?: Say briefly why| Default if unsure:| Offer a single_choice| Record the answer)/s.exec(
        focus,
      )?.[1];
    delta.contextAnswers = { [context]: "scripted answer" };
    delta.decisions = [
      { key: context, question: context, choice: "scripted answer", source: "default_accepted" },
    ];
    text = (ask?.trim() ? ask.trim() : undefined) ?? `About ${context.replace(/_/g, " ")}: what applies?`;
  } else if (finding) {
    meta.areaKey = "finding";
    text = `One thing to settle: finding ${finding}. The default is fine?`;
  } else if (mvp) {
    meta.areaKey = "mvp_challenge";
    text = `If version one shipped without ${mvp}, what breaks?`;
  } else if (key) {
    meta.areaKey = key;
    const name = areaName(system, key).toLowerCase();
    if (continuing) {
      delta.coverage = { [key]: { status: "covered", known: "answered" } };
      if (spec) {
        if (key === "functional") {
          facts.push(
            specField("functional", "FR-1", {
              title: "Single entry charting",
              scope: "mvp",
              acceptance: ["one form"],
            }),
            specField("functional", "FR-2", { title: "Excel export", scope: "mvp", acceptance: ["csv"] }),
            specField("functional", "FR-3", {
              title: "Ward overview screen",
              scope: "mvp",
              acceptance: ["one screen shows every bed"],
            }),
          );
        } else {
          facts.push(specField(SPEC_SECTIONS.has(key) ? key : "overview", "summary", `scripted ${name}`));
        }
      }
      text = `Tell me more about ${name}. What does a normal day look like there?`;
    } else {
      delta.coverage = { [key]: { status: "partial", known: "opened" } };
      text = `Let's talk about ${name}. How does that work for you today?`;
    }
  } else if (closing) {
    meta.areaKey = "closing";
    text = "Is there anything I missed that you would like to add?";
  } else if (summary) {
    meta.areaKey = "summary";
    meta.endInterview = true;
    text =
      "Thank you. Here is what I captured: the steps you described, where they hurt, and what you would change first.";
  } else {
    meta.areaKey = "context";
    text = "Go on, please.";
  }
  if (facts.length > 0) delta.facts = facts;
  if (Object.keys(delta).length > 0) meta.stateDelta = delta;
  return { text, meta };
}

function specField(section: string, path: string, value: unknown): Record<string, unknown> {
  return { kind: "spec_field", section, path, value, source: "user" };
}

/** The wire text of a turn: the message, the marker on its own line, then the metadata object. */
export function renderTurn(reply: TurnReply): string {
  return `${reply.text}\n${TURN_MARKER}\n${JSON.stringify(reply.meta)}`;
}

// ---------------------------------------------------------------------------------------------
// Structured calls

const PAINS = [
  "Orders are typed in twice, once in the shop system and once in the spreadsheet",
  "Approvals wait in someone's inbox for days",
  "Reports are rebuilt by hand every Friday",
  "Customer questions are answered from memory because the data is in three places",
  "Handover notes get lost between shifts",
];
const TASKS = [
  "Re-entering orders",
  "Chasing approvals",
  "Weekly reporting",
  "Answering status questions",
  "Writing shift handover notes",
];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Two facts out of a conversation: enough that clustering and the report have something to say. */
function scriptedFacts(seed: string): Json[] {
  const i = hash(seed) % PAINS.length;
  const j = (i + 1 + (hash(`${seed}!`) % 2)) % PAINS.length;
  return [
    {
      kind: "pain_point",
      description: PAINS[i] ?? "A manual step",
      severity: 6 + (i % 3),
      affectedTask: TASKS[i] ?? "A task",
    },
    {
      kind: "task",
      name: TASKS[j] ?? "A task",
      frequency: "weekly",
      minutesPerOccurrence: 20 + 10 * (j % 3),
      tools: ["spreadsheet", "email"],
      painScore: 5 + (j % 4),
    },
  ];
}

/**
 * The answer to a structured call: content where a pass needs it to mean something, otherwise the
 * smallest value the request's own schema allows.
 */
export function structuredAnswer(body: ChatBody): Json {
  const schema = schemaOfRequest(body);
  const props =
    schema && typeof schema === "object" && "properties" in schema
      ? ((schema as { properties?: Record<string, unknown> }).properties ?? {})
      : {};
  if ("facts" in props) {
    const text = (body.messages ?? []).map((m) => contentText(m.content)).join("\n");
    return { facts: scriptedFacts(text) };
  }
  const value = minimalValue(schema ?? {});
  // The specification pass: a document with diagrams in it, so PDF export has something for the
  // diagram renderer to draw and a drill exercises that pair for real.
  if ("sections" in props && "diagrams" in props && isRecord(value)) {
    return {
      ...value,
      title: "Scripted specification",
      diagrams: [
        {
          key: "context",
          title: "System context",
          type: "context",
          mermaid: "flowchart LR\n  clerk[Ward clerk] --> app[Charting app]\n  app --> store[(Records)]",
        },
        {
          key: "sequence",
          title: "Recording bed status",
          type: "sequence",
          mermaid:
            "sequenceDiagram\n  participant C as Clerk\n  participant A as App\n  C->>A: Enter status\n  A-->>C: Saved",
        },
        {
          key: "entity",
          title: "Data",
          type: "entity",
          mermaid: "erDiagram\n  BED ||--o{ STATUS : has\n  BED { string id }\n  STATUS { string value }",
        },
      ],
    };
  }
  return value;
}

const isRecord = (v: unknown): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A rough token count, the way the platform's own estimate does it: four characters to a token. */
export function tokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function promptText(body: ChatBody): string {
  return (body.messages ?? []).map((m) => contentText(m.content)).join("\n");
}
