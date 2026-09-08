# Interview round 1: Discovery Lead → product owner

The interview is adaptive: it asks only what changes the build, and it records a
default for every question so work is never blocked. Answer in any order, in any
amount of detail. "Yes, go with the default" is a valid answer.

Legend: **Why it matters** says which part of the build the answer changes.
**Default** is what the team builds if you do not answer.

## Q1. Who is the customer?

Is this an internal tool for one company, or a product sold to many companies?

- **Why it matters:** multi-tenancy, sign-up flow, billing, admin roles, data isolation.
- **Default (ASSUMED):** multi-company SaaS from day one, but MVP is validated with one
  company (yours). Tenancy is in the data model now; billing and self-serve sign-up are
  out of scope for v1.

## Q2. Who talks to the AI, and how?

Workflow 1 interviews employees. Is that a text chat, voice, or both? Live and
synchronous, or async where an employee comes back over several days?

- **Why it matters:** the interview engine's session model, transcript storage, and
  the whole front end.
- **Default (ASSUMED):** text chat, async, resumable. One interview can span several
  sittings. Voice is a later feature and the transcript model must not preclude it.

## Q3. Who consumes the outputs, and what do they do with them?

Workflow 1 produces opportunities. Who reads them: a leadership dashboard, a
consultant preparing a report, an innovation team? Workflow 2 produces specs. Are
they read by humans, pasted into a coding agent, or both?

- **Why it matters:** whether we build a ranked opportunity dashboard with company-wide
  aggregation, and what "developer-ready" means in practice.
- **Default (ASSUMED):** an admin dashboard aggregating opportunities across all
  interviews, ranked by value and effort. Specs are exported as Markdown for humans and
  as a coding-agent hand-off bundle (a task prompt plus `AGENTS.md`-style context).

## Q4. What does "developer-ready" mean to you?

Pick the level: (a) user stories with acceptance criteria, (b) that plus data model,
API contracts, and non-functional requirements, (c) that plus a task breakdown a
coding agent can execute one by one.

- **Why it matters:** the spec template, the rubric the AI uses to decide the
  interview is complete, and the eval set.
- **Default (ASSUMED):** (c). The interview is not complete until the rubric is
  satisfied.

## Q5. Privacy and consent

Employees will describe their daily work and frustrations. Do results need to be
anonymized before managers see them? Is explicit consent required? Where must data
live (EU only)?

- **Why it matters:** data model (identity separated from transcript), aggregation
  rules (minimum group size before reporting), hosting choice.
- **Default (ASSUMED):** EU hosting, GDPR posture. Consent screen at the start of every
  interview. Managers see aggregated opportunities, not raw transcripts, unless the
  employee opts in. Transcripts are deletable on request.

## Q6. Technology constraints

Any preferences or hard constraints: language, framework, database, LLM provider,
hosting? Must it support more than one LLM provider?

- **Why it matters:** everything downstream.
- **Default (ASSUMED):** TypeScript monorepo. Next.js (App Router) web app with server
  routes, Postgres with Prisma, Anthropic Claude as the default model behind a thin
  provider interface so another provider can be added. Docker for local dev.

## Q7. Scale for the first version

How many employees in the first real deployment? How many concurrent interviews?

- **Why it matters:** whether we need queues and background workers now.
- **Default (ASSUMED):** up to 200 employees, tens of concurrent interviews. No queue
  in v1; LLM calls run in request scope with streaming.

## Q8. Integrations

Should employees log in with company SSO? Should interviews be reachable from Slack or
Teams? Should specs go to Jira, Linear, or GitHub?

- **Why it matters:** auth provider, export adapters.
- **Default (ASSUMED):** email magic link and Google sign-in for v1. SSO, chat
  integrations, and issue-tracker export are v2. Spec export to GitHub as a Markdown
  file is cheap and included.

## Q9. The thing you are most worried about

Open question. What would make this product fail, in your view? Common answers: the
interviews feel like a survey and employees disengage; the opportunities are generic;
the specs look complete but a developer still has to guess.

- **Why it matters:** it sets the primary quality metric for the AI engineer and the
  first eval set.
- **Default (ASSUMED):** spec quality. Metric: a coding agent given the spec bundle
  builds the feature without asking a clarifying question.

## What happens next

Answers are recorded in `decisions.md`. Any default you do not overturn stays
`ASSUMED` in the spec and is marked as such. The Product Architect then turns
`02-draft-spec.md` into `docs/spec/` v1.0 and engineering starts.
