import { newNonce, wrapUntrusted } from "../util/untrusted.js";
import type { CallContext, ModelCaller } from "../callModel.js";
import type { PromptSource } from "../engine/prompts/index.js";
import { chunkText, type ChunkOptions } from "./chunk.js";
import { extractText, isImageMime, isTextMime, type ImageMime } from "./extract.js";
import { fileSummaryPromptV1 } from "./prompts/file-summary.v1.js";
import { imageDescribePromptV1 } from "./prompts/image-describe.v1.js";

/**
 * Reading an attachment once, so every later turn is cheap (FR-31, FR-32).
 *
 * The shape of the problem: a participant attaches a forty-page procedure, and the interviewer
 * needs to know it exists and roughly what is in it on every turn from then on, but needs the
 * actual wording only when it becomes relevant. So ingestion produces two things — a short summary
 * that rides along in context forever, and chunks that are retrieved on demand.
 *
 * Runs in the worker, not the request. Extraction of a large PDF and two model calls take seconds,
 * and the participant should be answering the next question meanwhile.
 */

export interface IngestInput {
  bytes: Buffer;
  mime: string;
  filename: string;
  /** Interview language, passed to the summary so it comes back in the same one. */
  language?: string;
}

export interface IngestResult {
  /** The document's own text, or the model's description of an image. */
  text: string;
  summary: string;
  chunks: string[];
  /** Vectors aligned with `chunks`, absent when no embedding route is configured. */
  vectors?: number[][];
  /** Pages, sheets, or undefined where the idea does not apply. */
  parts?: number;
  /** True when the file yielded no usable text — a scan, a blank form, an empty sheet. */
  empty: boolean;
}

export interface IngestDeps {
  caller: ModelCaller;
  prompts: PromptSource;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
  chunkOptions?: ChunkOptions;
}

/** Cap on the text handed to the summarizer, in characters. */
const SUMMARY_INPUT_CHARS = 24_000;
/** Cap on how many chunks one attachment may produce. */
export const MAX_CHUNKS = 400;

export async function ingestAttachment(
  deps: IngestDeps,
  ctx: CallContext,
  input: IngestInput,
): Promise<IngestResult> {
  const { text, parts, empty } = await readText(deps, ctx, input);

  if (empty) {
    // Nothing to summarize and nothing to retrieve. Saying so is the useful outcome: the
    // participant is told the file could not be read, rather than left believing it was.
    return { text, summary: "", chunks: [], empty: true, ...(parts === undefined ? {} : { parts }) };
  }

  const summary = await summarize(deps, ctx, text, input);
  const chunks = chunkText(text, deps.chunkOptions).slice(0, MAX_CHUNKS);
  const vectors = await embed(deps, ctx, chunks);

  return {
    text,
    summary,
    chunks,
    empty: false,
    ...(parts === undefined ? {} : { parts }),
    ...(vectors === undefined ? {} : { vectors }),
  };
}

/** A document is parsed; an image is described by a model, because there is nothing to parse. */
async function readText(
  deps: IngestDeps,
  ctx: CallContext,
  input: IngestInput,
): Promise<{ text: string; parts?: number; empty: boolean }> {
  if (isTextMime(input.mime)) {
    const out = await extractText(input.bytes, input.mime);
    return { text: out.text, empty: out.empty, ...(out.parts === undefined ? {} : { parts: out.parts }) };
  }
  if (isImageMime(input.mime)) {
    const text = await describeImage(deps, ctx, input.bytes, input.mime);
    return { text, empty: text.trim().length === 0 };
  }
  throw new Error(`Cannot ingest ${input.mime}`);
}

async function describeImage(
  deps: IngestDeps,
  ctx: CallContext,
  bytes: Buffer,
  mime: ImageMime,
): Promise<string> {
  const prompt = await deps.prompts.get(ctx.companyId, imageDescribePromptV1.key);
  let out = "";
  for await (const ev of deps.caller.chat("vision_ingest", withPrompt(ctx, prompt), {
    system: prompt.body,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image", mime, base64: bytes.toString("base64") },
        ],
      },
    ],
  })) {
    if (ev.type === "text") out += ev.text;
  }
  return out.trim();
}

async function summarize(
  deps: IngestDeps,
  ctx: CallContext,
  text: string,
  input: IngestInput,
): Promise<string> {
  const prompt = await deps.prompts.get(ctx.companyId, fileSummaryPromptV1.key);
  // Head and tail rather than the first N characters: the end of a procedure is where the
  // exceptions and the escalation paths live, and truncating from the front throws them away.
  const excerpt = clip(text, SUMMARY_INPUT_CHARS);
  const language = input.language ? `\n\nWrite the summary in this language: ${input.language}.` : "";
  let out = "";
  for await (const ev of deps.caller.chat("file_ingest", withPrompt(ctx, prompt), {
    system: prompt.body,
    messages: [
      {
        role: "user",
        content: `${wrapUntrusted("document", `File name: ${input.filename}\n\n${excerpt}`, { nonce: newNonce() })}${language}`,
      },
    ],
  })) {
    if (ev.type === "text") out += ev.text;
  }
  return out.trim();
}

/**
 * Embeds the chunks, or reports that it could not.
 *
 * `ModelCaller.embed` answers undefined when no `embedding` route is configured, which is the
 * common case: OpenRouter serves no embedding models at all. A throw is different — a route exists
 * and the provider failed — and is logged and swallowed for the same reason the analysis pipeline
 * swallows it: an attachment that is retrievable by keyword is worth far more than an attachment
 * that failed to ingest.
 */
async function embed(deps: IngestDeps, ctx: CallContext, chunks: string[]): Promise<number[][] | undefined> {
  if (chunks.length === 0) return undefined;
  try {
    const res = await deps.caller.embed(ctx, chunks);
    return res?.vectors;
  } catch (err) {
    deps.logger?.warn("embedding an attachment failed; chunks will be recalled lexically", {
      companyId: ctx.companyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function withPrompt(ctx: CallContext, prompt: { key: string; version: number }): CallContext {
  return { ...ctx, promptVersion: `${prompt.key}@${prompt.version}` };
}

/** Keeps the beginning and the end, marking the join so the model knows something is missing. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n[...omitted...]\n\n${text.slice(text.length - tail)}`;
}
