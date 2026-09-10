# Interview round 2: answers received, two questions answered, three follow-ups

## Round-1 answers recorded

| Q                  | Answer                                                                                                                                                              | Effect                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Q1 customer        | Multi-tenant OK, asked how AI cost is controlled                                                                                                                    | D-04 confirmed. Cost control becomes a first-class requirement (section A below). |
| Q2 modality        | Text, chat, voice, file upload: all                                                                                                                                 | D-05 overturned. Voice and file upload are in v1 (section C).                     |
| Q3 outputs         | All                                                                                                                                                                 | D-06 confirmed.                                                                   |
| Q4 developer-ready | Default                                                                                                                                                             | D-07 confirmed.                                                                   |
| Q5 stack           | Asked about agentic frameworks; requires provider configurability from the admin dashboard, not only Claude, including LiteLLM and OpenRouter, with model selection | D-09 partly overturned. Provider layer redesigned (section B).                    |
| Q6 worry           | Default                                                                                                                                                             | D-12 confirmed.                                                                   |

## A. How AI cost is controlled

Cost is controlled at four layers. Each is a requirement in spec v1.0 (FR-40 to FR-49).

**1. Measure everything.** Every model call is written to a ledger with purpose,
provider, model, input tokens, cached tokens, output tokens, latency, and computed
cost. Cost comes from a price table per model. OpenRouter and LiteLLM publish per-model
prices from their model endpoints, so those rows are imported automatically; Anthropic
and OpenAI rows are seeded and admin-editable. Nothing is estimated after the fact.

**2. Budgets that stop calls, not just report them.** A platform-wide default monthly
budget per tenant, which a tenant admin can lower but not raise. Below it: a per
campaign cap and a per interview turn cap. Before each call the guard checks the
remaining budget against a conservative estimate; after the call it records the actual.
At 80 percent the admin gets a warning; at 100 percent the interview shows a polite
"paused" message and the admin is notified. No silent overrun, no silent degradation.

**3. Route each purpose to the cheapest model that passes its eval.** The engine has
named purposes: interview turn, resume summary, fact extraction, clustering, spec
interview turn, spec generation, transcription, file ingestion. The admin maps each
purpose to a provider, model, effort level, and max output tokens. Interview turns
are chatty and frequent, so they run on a fast, cheap configuration. Spec generation
happens once per project and is the quality-critical step, so it runs on the strongest
configured model. Extraction and clustering are not user-facing, so they can go through
batch endpoints where the provider offers one, at half price.

**4. Spend fewer tokens per call.** The interview system prompt and topic set are
frozen, put first, and marked for prompt caching on providers that support it; on a
multi-sitting interview this is the single largest saving because every turn re-sends
the prefix. Long transcripts are not re-sent in full: after a threshold the engine
keeps a rolling summary plus the last N turns. Uploaded files are ingested once into
extracted text and then referenced by summary, not pasted into every turn. Turn caps
per interview stop runaway sessions.

Cost visibility: the admin dashboard shows spend per tenant, campaign, purpose, and
model, with the budget line, so the admin can see which lever to pull.

## B. Agentic framework: recommendation

**Recommendation: no agent framework. A thin provider layer of our own, about 500
lines, with two adapters.** Reasons:

1. The interview engine is not an open-ended agent. It is a state machine: load
   state, ask the model for the next question plus a structured state delta, persist,
   stream. That is a workflow, and workflow code is clearer without a framework's loop
   abstraction in the way.
2. Your requirement is runtime configurability from the admin dashboard: provider,
   base URL, key, model, per purpose. Frameworks bind providers at code level. We need
   a small registry that builds a client from a database row.
3. The cost levers in section A (caching markers, effort levels, structured output,
   batch) are provider-specific. A framework's common denominator hides exactly the
   knobs we need. Our adapter exposes them where the provider has them and no-ops
   where it does not.

The two adapters cover every provider you named:

| Adapter             | Serves                                                                         | Transport                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `anthropic`         | Anthropic direct                                                               | Official Anthropic SDK: streaming, prompt caching, structured outputs, effort                                      |
| `openai-compatible` | OpenAI, OpenRouter, LiteLLM proxy, any OpenAI-compatible server (Ollama, vLLM) | Chat Completions protocol with a configurable base URL and headers; model list from the provider's models endpoint |

Model selection: the admin picks a provider, the platform fetches its model list live
(OpenRouter and LiteLLM include pricing in that list), and the admin assigns models to
purposes. A "test this configuration" button sends one small call and reports latency
and cost.

If we later want UI conveniences (React chat hooks), the Vercel AI SDK's client hooks
can sit on top of our streaming endpoint without changing the server layer. That is a
frontend choice and does not affect this decision.

## C. Follow-ups raised by "all modalities"

### Q10. Voice: recorded or real-time?

- **Why it matters:** real-time speech-to-speech needs a WebSocket audio pipeline and a
  provider that supports it; recorded voice is a transcription step in front of the
  text engine.
- **Default (ASSUMED):** v1 is recorded voice. The employee holds a button, the browser
  records, the audio uploads, a configured speech-to-text provider transcribes it, and
  the transcript becomes a normal text turn (audio retained, deletable). Replies are
  text, optionally read aloud by the browser. Real-time speech-to-speech is v2.

### Q11. File upload: what files, and what happens to them?

- **Why it matters:** ingestion pipeline, storage, and how much of a file enters the
  model's context (cost).
- **Default (ASSUMED):** PDF, Word, Markdown, plain text, CSV, Excel, PNG and JPEG.
  Files are ingested once into extracted text (images through a vision-capable model),
  stored as attachments with a generated summary, and the interview references the
  summary and pulls full text only when a question needs it. Size cap 20 MB per file.
  Employees attach process docs and screenshots in Workflow 1; idea owners attach
  existing PRDs, mockups, and transcripts in Workflow 2.

### Q12. Where do provider API keys live?

- **Why it matters:** in multi-tenant SaaS, either the platform pays for all model
  usage and bills tenants, or each tenant brings their own keys.
- **Default (ASSUMED):** both. Platform-level providers are configured by the platform
  operator and available to every tenant under the tenant's budget. A tenant admin can
  additionally add their own provider with their own key, which bypasses the platform
  budget but still writes to the ledger. Keys are encrypted at rest and never returned
  to the browser after entry.
