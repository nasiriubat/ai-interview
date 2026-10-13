import { extractJson } from "./pure.js";
import { chat } from "./runtime.js";

export interface JudgeVerdict {
  perMessage: {
    n: number;
    singleQuestion: boolean;
    leading: boolean;
    suggestsSolution: boolean;
    concreteExample: boolean;
  }[];
  scores: Record<string, number>;
  worst: string;
  comment: string;
  raw?: string;
}

const DISCOVERY_RUBRIC = `You are a strict reviewer of AI interviewers. The interviewer's job: learn how a person's work is actually done (tasks, tools, manual steps, hand-offs, bottlenecks). Rules it must follow: ask one question at a time; never lead or presuppose an answer; never suggest solutions or ask where AI should be used; ask for concrete recent examples when a problem surfaces; accept short answers and move on; stay warm and brief.`;

const REQUIREMENTS_RUBRIC = `You are a strict reviewer of an AI requirements interviewer. Its job: help the owner of an idea produce a specification a developer can build from without asking questions. Rules it must follow: one question at a time; for a nontechnical owner use plain words and offer a recommended default with its consequence instead of asking open technical questions; for a technical owner be precise; raise ambiguities or contradictions one at a time; challenge scope (an MVP); do not accept vague requirements ("fast", "user friendly") without a measurable criterion.`;

export async function judgeTranscript(opts: {
  apiKey: string;
  model: string;
  kind: "discovery" | "requirements";
  transcript: { role: "assistant" | "user"; content: string }[];
  label: string;
}): Promise<JudgeVerdict | null> {
  const numbered: string[] = [];
  let n = 0;
  for (const m of opts.transcript) {
    if (m.role === "assistant") {
      n += 1;
      numbered.push(`[Q${n}] INTERVIEWER: ${m.content}`);
    } else {
      numbered.push(`PARTICIPANT: ${m.content.slice(0, 500)}`);
    }
  }
  const prompt = [
    opts.kind === "discovery" ? DISCOVERY_RUBRIC : REQUIREMENTS_RUBRIC,
    "",
    "Transcript:",
    numbered.join("\n"),
    "",
    `Return one JSON object: {"perMessage":[{"n":1,"singleQuestion":true,"leading":false,"suggestsSolution":false,"concreteExample":false}, ... one per interviewer message ${n} total],`,
    `"scores":{"followUpQuality":1-5,"nonRepetition":1-5,"adaptsToParticipant":1-5,"toneAndBrevity":1-5,"followsRules":1-5},`,
    `"worst":"the single worst interviewer message quoted verbatim, then why, in one sentence","comment":"two sentences overall"}`,
    "singleQuestion = the message asks exactly one thing. leading = it presupposes or steers the answer. suggestsSolution = it proposes or hints at a tool, automation or fix (a recommended default in a requirements interview does NOT count). concreteExample = it asks for a specific recent example, step or number.",
  ].join("\n");
  try {
    const r = await chat({
      apiKey: opts.apiKey,
      model: opts.model,
      label: opts.label,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 4000,
      json: true,
      temperature: 0,
    });
    const parsed = extractJson(r.content) as Partial<JudgeVerdict> | null;
    if (!parsed || !Array.isArray(parsed.perMessage))
      return {
        perMessage: [],
        scores: {},
        worst: "",
        comment: "unparseable judge output",
        raw: r.content.slice(0, 500),
      };
    return {
      perMessage: parsed.perMessage,
      scores: parsed.scores ?? {},
      worst: parsed.worst ?? "",
      comment: parsed.comment ?? "",
    };
  } catch (err) {
    return {
      perMessage: [],
      scores: {},
      worst: "",
      comment: `judge call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
