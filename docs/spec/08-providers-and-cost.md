# 08 Providers and cost

## Provider registry (FR-40 to FR-44)

Kinds: `anthropic`, `openai`, `openrouter`, `litellm`, `openai_compatible`, plus
`stt`, `tts`, and `realtime` provider kinds for voice. Fields: name, base URL,
encrypted key, headers, enabled, platform-level or tenant-level. Live model lists;
OpenRouter and LiteLLM prices imported. "Test configuration" sends one small call and
reports latency, tokens, cost. Adapter capabilities are explicit (caching, structured
output, effort, batch, vision, transcription, streaming speech) and the engine
degrades gracefully.

## Purposes and routing (FR-42)

`interview_turn`, `resume_summary`, `extraction`, `clustering`, `analysis_report`,
`spec_turn`, `issue_detection`, `spec_generation`, `transcription`, `stt_stream`,
`tts`, `realtime_voice`, `file_ingest`, `vision_ingest`, `embedding`. Each maps to
provider, model, effort, max output tokens, batch allowed, per tenant with platform
defaults. Chatty purposes default to the fast tier at low effort; one-shot,
quality-critical purposes default to the strongest tier.

## Cost control (FR-45 to FR-49)

- Ledger row per call: tenant, purpose, provider, model, prompt version, tokens (input, cache read, cache write, output), latency, status, computed cost, session and campaign.
- Price table per provider and model: seeded, admin-editable, provider-imported; admin overrides win.
- Budgets: tenant monthly (platform default; tenant may lower), campaign cap, session cap. Guard before each call with a conservative estimate; actuals recorded after.
- Warn at 80 percent (and again at 90); at 100 percent pause with a visible state, and tell the tenant's admins and the operator (D-90, D-91). Never silent: the participant is told the interview is paused, and is told "the organizer has been notified" only when an alert actually reached someone. There is no downgrade-to-a-cheaper-model behaviour; a lower soft budget is a second budget line.
- Fewer tokens per call: cached stable prefix, layered context (`03`), file summaries, turn caps, batch endpoints for non-interactive purposes.
- Spend dashboard by tenant, campaign, purpose, model, day.

## Framework decision

No agent framework. The model and cost layer is our own, on official SDKs and the Chat
Completions protocol. Rationale in `10-architecture.md`.
