# Decision log

| ID | Decision | Status | Source | Date |
|---|---|---|---|---|
| D-01 | Two core workflows: employee discovery interviews, and idea-to-spec interviews | DECIDED | intake | 2026-09-08 |
| D-02 | Output must be consumable by coding agents (Codex, Claude Code) as well as humans | DECIDED | intake | 2026-09-08 |
| D-03 | This repo is built using the product's own process (intake → interview → spec → build) | DECIDED | intake | 2026-09-08 |
| D-04 | Multi-tenant SaaS data model; MVP validated with one company | DECIDED | round 1 Q1 answer | 2026-09-08 |
| D-05 | Text chat, recorded voice, and file upload all in v1; async, resumable; real-time voice v2 | DECIDED | round 1 Q2 answer | 2026-09-08 |
| D-06 | Admin dashboard of ranked opportunities; spec export as Markdown plus agent bundle | DECIDED | round 1 Q3 answer | 2026-09-08 |
| D-07 | Developer-ready = stories + data model + API + NFRs + agent task breakdown | DECIDED | round 1 Q4 answer | 2026-09-08 |
| D-08 | EU hosting, consent screen, aggregated view for managers, deletable transcripts | ASSUMED | round 1 Q5 | 2026-09-08 |
| D-09 | TypeScript, Next.js, Postgres + Prisma. Providers configurable from admin dashboard: Anthropic, OpenAI, OpenRouter, LiteLLM, any OpenAI-compatible; model selection per purpose | DECIDED | round 1 Q5 answer | 2026-09-08 |
| D-10 | v1 scale: 200 employees, no background queue | ASSUMED | round 1 Q7 | 2026-09-08 |
| D-11 | Magic link + Google auth in v1; SSO and chat integrations v2 | ASSUMED | round 1 Q8 | 2026-09-08 |
| D-12 | Primary quality metric: agent builds from spec without clarifying questions | DECIDED | round 1 Q6 answer | 2026-09-08 |
| D-13 | Cost control: ledger with computed cost, enforced budgets (tenant, campaign, interview), per-purpose model routing, prompt caching and rolling summaries | DECIDED | round 2 A | 2026-09-08 |
| D-14 | No agent framework; own thin provider layer with `anthropic` and `openai-compatible` adapters | ASSUMED (recommended, awaiting owner confirmation) | round 2 B | 2026-09-08 |
| D-15 | Voice in v1: recorded audio transcribed first, real-time speech-to-speech in the same release track | DECIDED | round 2 Q10 answer: all | 2026-09-08 |
| D-16 | File upload: PDF, Word, Markdown, text, CSV, Excel, PNG, JPEG; ingested once, referenced by summary | DECIDED | round 2 Q11 answer: ok | 2026-09-08 |
| D-17 | Provider keys: platform-level providers under tenant budget, plus optional tenant-owned providers | DECIDED | round 2 Q12 answer: ok | 2026-09-08 |
| D-18 | Interview templates are data; the two workflows are seeded templates | DECIDED | intake v2 | 2026-09-08 |
| D-19 | Participation mode per campaign: identified, anonymous, or participant choice | DECIDED | intake v2 | 2026-09-08 |
| D-20 | Opportunities scored on seven factors with solution class ai, automation, software, process, none | DECIDED | intake v2 | 2026-09-08 |
| D-21 | Requirements interview adapts to technical level; detects ambiguity, contradiction, missing decisions, over-complexity; tags MVP vs future | DECIDED | intake v2 | 2026-09-08 |
| D-22 | Team is TypeScript end to end | ASSUMED | round 3 Q13 | 2026-09-08 |
| D-23 | Backend: Fastify API service plus worker; Next.js frontend only | ASSUMED | round 3 Q14 | 2026-09-08 |
| D-24 | Frontend: Next.js, React, Tailwind, shadcn/ui; one app, role-based routes | ASSUMED | round 3 Q15 | 2026-09-08 |
| D-25 | Data: Postgres + pgvector, S3-compatible storage, pg-boss jobs, no Redis | ASSUMED | round 3 Q16 | 2026-09-08 |
| D-26 | Hosting: Docker Compose on an EU VPS for the pilot | ASSUMED | round 3 Q17 | 2026-09-08 |
| D-27 | Auth: Auth.js, magic link + Google; anonymous participants on signed links; SSO later | ASSUMED | round 3 Q18 | 2026-09-08 |
| D-28 | Admin surface as proposed in round 3 Q19, retention and consent text fixed in v1 | ASSUMED | round 3 Q19 | 2026-09-08 |
| D-29 | Architecture: modular monolith, ports and adapters, template-driven state machine, append-only events, jobs, row-level tenancy | ASSUMED | round 3 Q20 | 2026-09-08 |
