# 07 Admin dashboard

Principle: the dashboard shows the numbers and holds the knobs. If a value could
plausibly change per customer or per month, it is a setting with a sensible default,
not a constant in code.

## Stats

- Participation: campaigns open; invited, started, completed; median length; drop-off by area; identified vs anonymous share; reminders sent.
- Discovery results: opportunities by solution class; top ten by rank; evidence counts; "AI not appropriate" count.
- Requirements: projects by status; average turns to completion; findings by type; exports made.
- AI operations: spend by day, purpose, model, provider, campaign, against budget lines; cache hit rate; latency percentiles; error and refusal rates; tokens per interview; voice latency and interruption rates.
- Health: job queue depth and failures; provider test results; storage used; prompt version canaries.

## Configurable without code

- Templates: everything in `01`, with versions, rollback, preview, diff against shipped.
- Prompts: every system prompt editable per tenant with the shipped version as reset and a diff view; canary a prompt version to a share of sessions.
- Scoring: weights, presets, class thresholds.
- Providers, models, routing per purpose, effort, max tokens, batch flags, price table, test configuration.
- Budgets at three levels and a warning threshold. At 100 percent the budget pauses and the tenant's admins and the operator are notified (D-91); there is no behaviour knob.
- Campaign defaults: max turns, completion threshold, link expiry, consent text, participant fields, domain restriction, verification.
- Privacy: retention period, k for anonymity, who sees raw transcripts, deletion handling.
- Exports: sections on or off, bundle format, GitHub target, PDF branding.
- Feature flags per tenant: options view, recorded voice, real-time voice, files, chaining, collaboration, languages.
- Branding: name, logo, colors, email sender, interview page wording.
- Notifications: who gets budget warnings, completion notices, analysis-ready notices.

## Surface by role

Platform operator: tenants (create, suspend, default budget, region), platform
providers, routing defaults, seeded templates, global stats, flags per tenant.
Company admin: users and roles; templates; campaigns and invitations; results and
report; requirements projects; providers and routing overrides; budgets and spend;
privacy; audit log; settings above.
Member: own requirements projects; campaigns they are invited to administer.
