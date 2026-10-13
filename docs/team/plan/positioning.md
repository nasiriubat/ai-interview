# Positioning, landing content and launch proof

Everything below is grounded in `docs/spec/`, `docs/team/status-2026-10-13.md`, the interviewer prompt (`packages/ai/src/engine/prompts/interviewer.v4.ts`), the analysis pipeline (`packages/ai/src/analysis/pipeline.ts`, `report.ts`), the spec package (`packages/ai/src/spec/*.ts`), the two seeded templates and `apps/web/src/i18n/en.ts`. Where a claim is not yet true in the code it is marked **planned** or **gap**.

---

## 0. Claim inventory (what you may say, and where it lives)

| Claim                                                                                              | Evidence                                                                                                                                                                                        | Status                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Many interviews become one collective analysis                                                     | `runAnalysis` embeds facts, clusters, merges/names clusters by model, aggregates per cluster, ranks (`pipeline.ts`)                                                                             | Built                                                                                                                      |
| k-anonymity on quotes, roles, departments                                                          | `clusterStats()` returns quotes/roles/departments only when `participants >= k`; `privacy.kAnonymity` default 3                                                                                 | Built. **Gap:** `evidence` snippets are not k-gated (status review); close before pilot or do not show evidence to members |
| Seven scored factors with rationale, tenant-tunable weights and presets                            | `OpportunityDraftSchema`, `rankScore(factors, weights)`, `analysis.weightsPreset`, `analysis.weights`                                                                                           | Built                                                                                                                      |
| "AI is the wrong answer" is a first-class outcome                                                  | Solution class `none`, `whyNotAi`, report section "Where AI is not appropriate"; discovery template "Never ask where AI should be used. Do not suggest solutions."                              | Built                                                                                                                      |
| Consistent structured extraction across N interviews                                               | `extraction.v1` with fixed fact kinds (task, process, information_flow, pain_point, opportunity_candidate), zod-validated, runs every N turns; analysis reads facts never transcripts (spec 03) | Built                                                                                                                      |
| Same interview for every employee, engine reads only the template                                  | FR-64, `selection.ts` focus rules, templates as JSON, template versions pinned per campaign, preview route, "Diff against shipped"                                                              | Built (template rollback UI: **planned**)                                                                                  |
| Every turn has a recorded reason, replayable                                                       | Turn object `reason`, session event log, admin "Event replay"                                                                                                                                   | Built                                                                                                                      |
| Per-turn state persisted; resume from state not transcript                                         | Spec 02, state in DB                                                                                                                                                                            | Built. Resume recap text exists but is not shown (**gap**)                                                                 |
| Cost control: budgets at tenant, campaign, session; ledger per call; spend by purpose and campaign | `ModelCaller`, `BudgetGuard`, `LedgerSink`, `/stats` grouped `costCents`                                                                                                                        | Built. Budget alerts go to logs only (**gap**: nobody is notified; participant text says otherwise)                        |
| Audit log of admin actions with diffs                                                              | `audit` module; every admin route writes `diff`                                                                                                                                                 | Built                                                                                                                      |
| Versioned specifications with diffs                                                                | `/requirements/:id/versions`, `/versions/:v/diff/:other`, `diffSpecs()` section- and requirement-level                                                                                          | Built                                                                                                                      |
| Agent bundle: AGENTS.md, PLAN.md, tasks/phase-N.md, spec.md, spec.json, CLAUDE.md                  | `renderBundle()`; formats `claude_code`, `codex`, `generic`                                                                                                                                     | Built                                                                                                                      |
| Push to GitHub                                                                                     | `/requirements/:id/versions/:v/github`, `GitHubPort`                                                                                                                                            | Built (verify against a real repo before claiming publicly)                                                                |
| Issue detection: ambiguity, contradiction, missing decision, over-complexity; one push-back        | `issues.ts`, `selectFindings`, aggressiveness gentle/standard/strict                                                                                                                            | Built                                                                                                                      |
| MVP challenge ("if version one shipped without this, what breaks?")                                | interviewer v4, `nextMvpItem`                                                                                                                                                                   | Built                                                                                                                      |
| Technical / nontechnical path; recommendations instead of questions on the nontechnical path       | `requirements_discovery.json` paths, `technical_recommended` area                                                                                                                               | Built                                                                                                                      |
| Chaining discovery into requirements with hand-off                                                 | `/opportunities/:id/promote`, `seedStateFromHandoff()` marks areas partial and "asks only what is missing"                                                                                      | Built                                                                                                                      |
| Text, options, recorded voice, live voice, documents and photos                                    | Phase 4 (status: 82%, mostly uncommitted)                                                                                                                                                       | Built, land it first                                                                                                       |
| EU self-hosting on one VPS, API not on the internet                                                | `docs/DEPLOY.md`                                                                                                                                                                                | Built                                                                                                                      |
| Your transcripts go only to the model provider you configure; EU or self-hosted endpoints possible | Provider kinds incl. `openai_compatible` and `local` Whisper; `ProviderConfigSource` per tenant                                                                                                 | Built (self-hosted TTS **planned**)                                                                                        |
| Consent text per tenant/campaign, consent version + timestamp per session                          | `campaign.consentText`, spec 11                                                                                                                                                                 | Built                                                                                                                      |
| Anonymous mode: email verified once, only a salted hash stored on the campaign                     | Spec 06, `CampaignEmailHash`                                                                                                                                                                    | Built. **Gap:** platform-key hash, no per-campaign salt; timing de-anonymisation on small campaigns                        |
| Participant can delete everything, retention default 24 months with automatic sweep                | `privacy.retentionMonths`, daily `privacy.retention-sweep`                                                                                                                                      | Built. **Gap:** deletion leaves Participant/Invitation/email rows; fix before you promise "everything"                     |
| Who may open raw transcripts is a setting                                                          | `privacy.rawTranscriptsVisibleTo` default `admins_when_identified_and_opted_in`                                                                                                                 | Built (member enforcement **gap**)                                                                                         |
| Tenant isolation: scoped client plus RLS, tested with cross-tenant reads                           | NFR-03, RLS preflight                                                                                                                                                                           | Built on 13 tables; **gap** on Message, SessionEvent, Analysis, Opportunity, Report and others                             |
| PDF export                                                                                         | Browser "Print or save as PDF" only; Kroki PDF                                                                                                                                                  | **Planned**                                                                                                                |
| Department comparison, participant data export, sub-processor list, notifications, collaboration   |                                                                                                                                                                                                 | **Planned**                                                                                                                |

Rule for the landing page: say what is in the "Built" column; never put a "planned" item in present tense.

---

## 1. The differentiation argument

### 1a. What a chat tool structurally cannot do here

A chat window is one person, one conversation, one output, no memory of anyone else. The product is built around the things that need more than that.

1. **Many people, one analysis.** Forty employees do not share one ChatGPT thread. Here every interview produces typed facts (task, process, information flow, pain point) that are embedded, clustered across the whole campaign, aggregated with participant counts and self-reported hours per week, and scored. The report is about the organisation, not about the person who happened to be typing.
2. **Anonymity with a rule, not a promise.** A quote, a role or a department appears in the report only when at least k people (default three) are behind it. The number is a setting, enforced in code, visible in the report's method section. A chatbot cannot know who else said something.
3. **The same interview for everyone.** The engine reads a template: coverage areas in order, a "done when" criterion per area, follow-up limits, one question per turn, no solution suggestions. Every participant gets the same structure; a campaign pins the template version. There is no way to do that with a prompt pasted into forty separate chats.
4. **Nothing depends on the model remembering.** State is persisted every turn (coverage, open threads, decisions, facts). The interview resumes from state after a week; analysis reads the facts, never the transcript. Extraction runs on a fixed schema every few turns, so the forty-first interview is extracted exactly like the first.
5. **The interviewer is allowed to say "not AI".** The discovery template never asks where AI should go and never suggests solutions. The analysis has five solution classes, one of which is `none`, each with a written reason, and the report has a section "Where AI is not appropriate". A vendor's assistant is not built to recommend against its own category.
6. **Cost is a control, not a surprise.** Every model call goes through one gate with a purpose, a route, a budget check (tenant, campaign and session caps) and a ledger row with tokens and cost. Spend is visible per campaign and per purpose. A team using personal chat accounts has none of this.
7. **A specification is a versioned object.** Each version freezes `spec.md`, `spec.json` and the agent bundle. Reopening a session creates the next version and diffs it against the last, by section and by requirement id. Requirements carry stable ids (FR-1, FR-2) that survive into commits and tests.
8. **Developers and agents get a bundle, not prose.** `AGENTS.md` with context and working rules, `PLAN.md` with phases, one task file per phase with acceptance checkboxes, `spec.md`, `spec.json`, and `CLAUDE.md` for Claude Code or the Codex layout. Open questions carry the default taken, so the agent is told not to ask.
9. **Your infrastructure, your providers.** Runs on a single EU server behind Caddy; the API is never on the internet. The organisation chooses the model provider per purpose, including an OpenAI-compatible endpoint it hosts itself, and on-server Whisper for transcription. Keys are encrypted at rest and never reach the browser.
10. **Deletion and retention are jobs, not requests.** A participant can delete their answers, recordings, files and extracted facts from the interview screen; a daily sweep removes session data after the retention period (default 24 months). Consent text is per tenant, versioned and timestamped per session. Admin actions are audited with diffs.

### 1b. Possible in a chat, but unreliable or unscalable

- **Interviewing 40 people.** Someone has to run forty conversations, keep each on track for 30 to 45 minutes, and then read forty transcripts. Here each person opens a link on their phone, answers by text, options, voice or by attaching a document, pauses and comes back, and the engine does the reading.
- **No leading questions.** A chat model drifts toward solutions and toward confirming what the asker hopes. The template says "never ask where AI should be used, never suggest solutions", the engine enforces one question per turn, and every turn is stored with its reason so an admin can audit why a question was asked.
- **Same coverage every time.** In a chat, coverage depends on the operator's attention. Here the nine areas of the discovery template each have a done-when criterion and the engine tracks `untouched / partial / covered` per area; participants see progress and can skip and return.
- **No transcript leakage to a vendor.** Consumer chat tools default to using conversations for training or retain them under the vendor's policy. Here content goes only to the provider the organisation configured, and the organisation can pick an EU or self-hosted endpoint.
- **Difficult conversations handled consistently.** Three minimal answers in a row shorten the interview to essential areas; venting is acknowledged and parked as a thread; distress stops probing and raises a flag for the admin without storing a judgment about the person. A chat prompt may do this once; it will not do it the same way forty times.
- **Contradictions caught before the developer finds them.** The requirements interview runs a separate issue-detection pass every five turns over the spec state (not the transcript) and raises one finding at a time with a proposed resolution and a default; it pushes back once, then records your choice.

### 1c. What ChatGPT does equally well (say this out loud)

- **One person, one idea, a first draft.** If you are a founder who wants a decent PRD draft tonight, ChatGPT with a good prompt gets you 70% of the way. This product earns its place when the draft must be challenged, versioned, handed to an agent with ids and acceptance criteria, or when the idea came from thirty interviews rather than from your head.
- **Writing quality.** The prose in the report and the spec comes from the same class of models. The product's value is in what goes into the prompt (structured facts, counts, k-rule, seven factors, context block) and what is done with the output (schema validation, versioning, diffs, bundles), not in better sentences.
- **A quick brainstorm of automation ideas.** If you already know your processes and want ideas, a chatbot is faster. This product is for finding out how work is actually done when nobody has written it down.
- **One-off summarisation of a document you already have.** Attach-and-summarise is table stakes; the product does it too, but it is not the reason to use it.
- **Cost of the model tokens themselves.** The product does not make tokens cheaper; it makes them fewer (cached prefix, layered context, facts instead of transcripts) and accountable.

A sceptic who hears you concede these points will believe the other ten.

### Short forms

**One sentence.** A chatbot can interview one person once; this interviews everyone the same way, analyses what they said together without exposing anyone, and turns the result into a specification a developer or a coding agent can build from, version by version.

**One paragraph.** Asking ChatGPT to interview your staff gives you one transcript per chat window and a report that depends on who was typing. This platform runs the same structured interview for every participant, by text, options or voice, on their phone, with consent and anonymity rules enforced in code: a quote appears only when at least three people are behind it. Facts are extracted on a fixed schema from every interview, clustered across the whole campaign, and scored on seven factors, and the analysis is allowed to conclude that AI is the wrong answer. A selected opportunity, or any rough idea, then goes through a requirements interview that challenges ambiguity, contradictions and scope creep, and produces a versioned specification with stable requirement ids, phased tasks with acceptance criteria, and a bundle written for Claude Code or Codex. It runs on your EU server, with the model providers you choose, with a cost ledger per call and an audit log per admin action.

**Thirty seconds, spoken.** "You could ask ChatGPT to interview your team. You would get forty separate chats, forty slightly different interviews, and a report written from whatever the model remembered. What we built does three things a chat window cannot. First, it interviews everyone the same way, from a template, one question at a time, and it never pitches a solution. Second, it analyses all the interviews together, with a hard rule that nothing is quoted unless at least three people said it, and it is allowed to conclude that AI is not the answer. Third, when you pick an opportunity, it interviews you about it, argues with you about scope, and hands your developer or your coding agent a specification with numbered requirements and acceptance criteria, versioned, with diffs. It runs on a server in the EU, on model providers you choose, with every euro of model spend on a ledger. The principle is simple: understand the problem before deciding what to build."

---

## 2. Landing page content (English; Finnish to follow)

Section names are suggestions for component boundaries in `apps/web/src/app/page.tsx`, which currently redirects to `/admin`.

### Hero

**Eyebrow:** For organisations that want to know before they build

**Headline:** Understand the problem before deciding what to build.

**Subhead:** Structured AI interviews with your employees become a scored map of where work gets stuck and what, if anything, should change. Any opportunity or idea becomes a specification your developers or coding agent can build from. On your server, with your rules.

**Primary button:** Start a workspace
**Secondary button:** Have a link? Open your interview
**Small print under buttons:** No account for participants. Self-hosted in the EU. Every model call on a ledger.

### Two paths, one bridge

**Path 1, Discovery interviews**
_For HR, operations and transformation leads_

Invite your people by link. Each one has a 20 to 40 minute conversation, by text, options or voice, about how their work is actually done: role, daily activities, repetitive tasks, tools, manual steps, hand-offs, bottlenecks, problems. The interviewer asks one question at a time, goes one level deeper when a process surfaces, and never asks where AI should be used.

When enough people have answered, the interviews are analysed together. Similar tasks and problems are grouped, counted, and scored on seven factors: impact, people affected, frequency, simplicity, data availability, risk and AI fit. Each opportunity is classified as AI, automation, software, process change, or no change recommended.

You receive an organisation report: executive summary, work map, opportunities by class, quick wins versus strategic bets, where AI is not appropriate and why, and the three opportunities to take further.

**The bridge**

Select an opportunity and start a requirements interview from it. The problem, affected roles, existing process, tools, constraints and expected benefit are carried over and marked as known. The second interview asks only what is still missing.

**Path 2, Requirements interviews**
_For product owners, CTOs, founders and consultants_

Start from a sentence, a document, or a discovered opportunity. Say whether you are technical or not. The interviewer first settles the context: hosting, existing systems, who builds, what the team knows, timeline, budget, users at launch, compliance. Then it works through users, stories, requirements, rules, data, integrations, security, the admin surface, MVP and future scope, and phases, one decision per question, each with a reason and a default.

Every five turns a separate pass checks the specification for ambiguity, contradictions, missing decisions and unnecessary complexity, and raises one finding at a time. Before finishing it walks your MVP list and asks of each item: if version one shipped without this, what breaks?

You receive a versioned specification: `spec.md`, `spec.json`, and a bundle for Claude Code or Codex with context, a phase plan and one task file per phase with acceptance criteria. Reopen it later and see the diff.

### How it works: discovery

1. **Create a campaign from a template.** Choose identified, anonymous or participant's choice. Set the consent text, the expected length and who may see transcripts. Preview the interview yourself before sending.
2. **Share one link, or send personal invitations.** Participants verify their email once so each person answers once. In anonymous campaigns the email is never stored with the answers.
3. **People talk.** On a phone, in a browser, no app. Chat, tap options, record an answer, speak live, or attach a document. Pause and come back; nothing is lost. Delete everything with one tap.
4. **Read the report.** Analysis runs when the threshold is reached or when you press Analyze. Merge or dismiss opportunities, adjust the weights, hide sections, download Markdown, and promote the ones worth building into a requirements interview.

### How it works: requirements

1. **Describe the idea.** A sentence is enough. Attach what you have. Or start from a discovered opportunity and skip what is already known.
2. **Settle the context first.** Eight questions about hosting, builders, skills, timeline, budget, scale and compliance shape every later question and default.
3. **Decide, one question at a time.** Each question states why it matters and offers a default you can accept in one word. Findings are raised as they appear; the interviewer pushes back once, then records your choice.
4. **Ship the bundle.** Download the specification and the agent bundle, or push it to a GitHub repository. Every version is kept; reopening creates the next one with a diff.

### Why not just use a chatbot?

You can ask a chatbot to interview your team. Here is what you get instead.

| With a chat window                                  | Here                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One conversation at a time, each slightly different | The same templated interview for every participant, version pinned per campaign                                                                        |
| A transcript per person for someone to read         | Facts on a fixed schema, clustered and counted across the whole campaign                                                                               |
| Anonymity as a promise                              | A quote appears only when at least three people are behind it; the rule is a setting and is printed in the report                                      |
| A model that wants to help build something          | An analysis allowed to answer "no change recommended", with the reason                                                                                 |
| A document                                          | A versioned specification with stable requirement ids, acceptance criteria, phased tasks, and a diff between versions                                  |
| Whatever the vendor's retention policy says         | Your EU server, your choice of model provider, a ledger of every call, an audit log of every admin action, deletion on request and automatic retention |

What a chatbot does just as well: a first draft for one person with one idea, and good prose. If that is what you need tonight, use it. Come back when the idea has to survive contact with thirty colleagues or one coding agent.

### Trust

**Privacy.** Participants never need an account. Consent text is yours to write, and the version each person agreed to is recorded. Who may open raw transcripts is a setting; the default is admins only, and only when the participant chose to be identified.

**Anonymity.** In anonymous campaigns, the email is used once to make sure each person answers once, then only a hash remains on the campaign, never on the session. The report shows a quote, a role or a department only when at least three participants are behind it. Three is the default; you can raise it.

**EU hosting.** The whole stack runs on one server in the EU: web, API, worker, Postgres, backups. The API is not reachable from the internet. Model calls go only to the providers you configure, per purpose; you can point interview turns at an EU endpoint and transcription at Whisper running on the same server.

**Your data.** Participants can delete their answers, recordings and files from the interview screen. Session data is deleted automatically after the retention period you set (24 months by default). Admin actions are logged with what changed.

**Cost transparency.** Every model call is recorded with its purpose, provider, model, tokens and cost. Budgets exist at tenant, campaign and session level, and the interview pauses visibly when a budget is reached. Spend is shown per campaign and per purpose.

_(Keep this section honest: do not write "deletion removes everything" or "you will be notified when a budget is reached" until the deletion scope and alerting gaps from the status review are closed.)_

### Who it is for

- **HR and operations leads** who need to know where time goes before the next tooling decision, and who want staff to be able to speak frankly.
- **CTOs and heads of digital** who are asked "what should we do with AI" and want an answer that may include "nothing here".
- **Consultancies** running discovery for clients: one tenant per client, templates you own, a report you can stand behind, and a specification you can hand to the client's developers or your own.
- **Product owners** who have an idea and a developer waiting, and want the questions asked before the sprint, not during it.
- **Developers and coding agents** who would rather receive numbered requirements, acceptance criteria and a phase plan than a slide deck.

### FAQ

**Can't I just use ChatGPT for this?**
For one person drafting one idea, yes, and it will be decent. This is for when many people have to be interviewed the same way, when nobody's words may be exposed, when the answer may be "do not build this", and when the result has to be a versioned specification a developer or agent can work from. See "Why not just use a chatbot" above for the honest comparison.

**Is it anonymous?**
It can be. The campaign owner chooses identified, anonymous, or lets each participant choose. In anonymous mode your email is used once to confirm you are a real, single participant; a hash is kept on the campaign and nothing on your interview. In the report, quotes and breakdowns appear only when at least three people are behind them.

**Where is my data?**
On the organisation's own server in the EU. Interview text is sent only to the model providers the organisation has configured, which can be EU endpoints or models the organisation hosts itself. Recordings are transcribed on the server when local transcription is enabled.

**Does the AI decide what we should build?**
No. The discovery interviewer never asks where AI should be used and never suggests solutions. The analysis scores each opportunity and may classify it as "no change recommended", with the reason. The requirements interview offers defaults; you decide, and your decision is recorded.

**What do developers receive?**
A specification in Markdown and JSON, with requirements numbered FR-1, FR-2 and so on, each tagged MVP or future with acceptance criteria; business rules; technical decisions marked specified or recommended with alternatives; data entities; integrations; the admin surface; open questions with the default taken; and implementation phases. Plus a bundle for Claude Code or Codex: `AGENTS.md`, `PLAN.md`, one task file per phase. Versions are kept and diffed.

**What does it cost?**
Two parts. The platform (self-hosted or run for you) and the model tokens. Every call is recorded with its cost, and you set budgets at tenant, campaign and session level. We publish a measured cost per interview from pilot campaigns rather than an estimate. _(Insert the figure from section 5 once measured.)_

**How long does an interview take?**
Discovery interviews are designed for 20 to 40 minutes and stop when the areas are covered, when the participant says they are done, or at the turn cap. Participants can pause and reopen the link. Requirements interviews are longer and are usually done in two or three sittings.

**Can we change the questions?**
Yes. Interviews are templates: coverage areas with "done when" criteria, instructions, follow-up limits, widgets, privacy mode, outputs. Copy a shipped template, edit it, preview it as a throwaway session, publish a version. Campaigns pin a version. The engine has no template-specific code.

**What if someone gives one-word answers or goes off topic?**
The interviewer switches to concrete prompts and option widgets, and after three minimal answers shortens the interview to the essential areas. Off-topic remarks are acknowledged and parked. If someone appears distressed, the interviewer stops probing and flags the session for the organiser without recording any judgment about the person.

**Who can read the transcripts?**
A setting. The default is: admins, only when the participant chose to be identified. Members see aggregated results. Participants see their own editable summary at the end.

### Calls to action

**For an admin (bottom of page and after "two paths")**
Heading: Run your first campaign this week.
Body: Create a workspace, copy the shipped discovery template, preview it on yourself, invite five colleagues. The first report tells you whether the next thirty interviews are worth it.
Buttons: Start a workspace · Talk to us about a guided pilot

**For a participant arriving by link (a distinct, quieter block near the top)**
Heading: Were you sent a link?
Body: You do not need an account or this page. Open the link you received; it explains who is asking, why, how long it takes, what is stored and how to delete it. You can answer by typing, tapping options or speaking, pause whenever you like, and nothing is quoted in a report unless several people said something similar.
Button: Open my interview link (focuses an input for pasting the link, or simply instructs to open the email)

**For consultancies (one line under the admin CTA)**
Running discovery for clients? Each client is a separate tenant with its own templates, providers, budgets and report. Ask about operator access.

---

## 3. In-product wording recommendations

Current strings are quoted from `apps/web/src/i18n/en.ts` and `packages/shared/src/settings.ts`. Proposals keep the product's register: plain, specific, no persuasion.

### Consent screen (`participant.consent` + `campaign.consentText` default)

Current default consent text:

> This interview is recorded to help your organization understand how work is done. You can pause, stop, or delete your answers at any time.

Problems: "recorded" reads as audio even for text; it says nothing about what is not asked, who reads it, or where it goes; "delete your answers" overstates until the deletion gap is fixed.

Proposed default (tenants can edit; keep under about 90 words because the screen requires reading to the end):

> This is a structured interview about how your work is done, one question at a time. It asks what you do, with which tools, and where work gets stuck. It does not ask where AI should be used and it will not suggest solutions.
>
> Your answers are stored by {organisation} on its own systems and sent only to the AI provider it has configured. Results are reported in aggregate; a quote appears only when at least {k} people said something similar.
>
> You can pause, skip any question, stop, or delete your answers, recordings and files at any time from the interview screen.

Notes: `{organisation}` and `{k}` interpolation is **planned** (the setting is a plain string today); until then write the number in. The "does not ask where AI should be used" sentence is true for the shipped discovery template; the requirements template uses `participant.invite.*` instead, which is fine. Rename `consent.title` from "Before we start" to "What you are agreeing to" and keep `consent.start` "Start the interview".

### Arrival screen (`participant.arrival.*`)

Keep: `welcome` ("{company} would like to hear how your work really goes."), `storedAnonymous`, `noAccount`.

Change:

- `storedIdentified`: "Your answers and, because you are identified, your email. Nothing is shared outside your organization." to "Your answers, with your name and email, visible to the people running this campaign. Nothing leaves your organisation's systems except the text sent to the AI provider it has chosen."
- `deletePromise`: "You can pause, stop, or delete everything you said at any time from the interview screen. Deletion is immediate." to "You can pause, stop, or delete your answers, recordings and files at any time from the interview screen." Add "and your contact details" only after the deletion scope fix (status review item 2) lands.
- Add a line under `purposeHeading` that admins cannot remove, keyed e.g. `arrival.method`: "One question at a time. It asks how your work is done, not where AI should be used. Answer briefly or in detail; skip anything."
- `poweredBy`: "Interview run with {product}" to "Interview run on {product}, hosted by your organisation" (true for self-hosted tenants; make it conditional if you ever offer hosted tenants).
- `details.anonymousHint`: "Your answers are stored without your identity. Only aggregated results carry them." to "Your answers are stored without your name or email. They appear only in aggregated results, and a quote only when at least three people said something similar."

### End-of-session summary (`participant.summary.whatNextBody`)

Current: "Your answers are combined with those of your colleagues. Nothing is attributed to you without your consent, and you can still delete your data from this page."
Proposed: "Your answers are combined with your colleagues' and analysed together. The report counts how many people described each task or problem and quotes something only when at least three people said it. You can still delete your data from this page."

### Report cover (`renderReport()` in `packages/ai/src/analysis/report.ts`, `admin.report.*`)

Current cover: `# Discovery report: {campaign}` then "Generated {date} (preliminary ...)" then the executive summary. The method sentence ("Quotes and breakdowns appear only where at least k participants are behind them. Durations are self-reported.") sits later, under Participation.

Proposed cover block (a small change to `renderReport`, all values are already in `ReportInput` except prompt versions, which are in `AnalysisResult.stats`):

> # {campaign}: what the interviews found
>
> Version {n} · generated {date} · {preliminary label if below threshold}
>
> **Method.** {completed} of {invited} invited people completed a structured interview about how their work is done; {analyzed} interviews were analysed. The interviewer followed one template for everyone, asked one question at a time, and did not suggest solutions. Facts were extracted on a fixed schema, grouped across all interviews, and scored on seven factors. Durations are self-reported.
>
> **What this report does not do.** It does not attribute anything to an individual. A quote, a role or a department appears only when at least {k} participants are behind it. It does not assume AI is the answer: each opportunity is classified as AI, automation, software, process, or no change recommended, with the reason.
>
> **Reproducibility.** Template {key} v{version}; prompts {promptVersions}; weights preset {preset}.

Also change `admin.report.subtitle` from "The organization report from the analysis, with process maps." to "What the interviews found, analysed together. Nothing here is attributed to one person." and `preliminaryNote` to "Preliminary: fewer interviews than the completion threshold. Counts may change; treat rankings as indicative."

### One correction that is not wording

`turn-runner.ts` tells a participant "The organizer has been notified" when a budget is reached, and nobody is (status review item 3). Change the string to "Your answers are saved. Please come back later." until an `AlertPort` exists.

---

## 4. Naming

Today: package scope `@aidp`, root package `ai-discovery-platform`, README and OpenAPI title "AI Discovery Platform", `branding.productName` default "Discovery", `app.name` "Discovery" in `en.ts` and `fi.ts`, OpenRouter `x-title` "AI Discovery Platform".

**The case against keeping "Discovery" / "AI Discovery Platform":** unsearchable; "discovery" means legal document disclosure in English and a Jira/Atlassian product; "AI ... Platform" is the most generic three-word combination in the category and signals the opposite of the product's principle (it leads with AI). It also competes with the product's own vocabulary ("discovery interview", "Discovery results") so the brand and the feature name collide in the UI.

**The case for keeping it:** zero cost; tenants rebrand anyway through `branding.productName`; the consultancy will sell under its own name. If you keep it, at least drop "AI" and "Platform" from the public title.

Five options:

1. **Askel** (Finnish: "step"; reads as "ask" + "-el" in English). Rationale: the product is a step before building, the pipeline is a sequence of steps, and it is literally about asking. Short, pronounceable in both languages, two syllables, no obvious software collision. Risk: minor existing Finnish uses of the word; check the .fi/.com domain and the EU trademark register.
2. **Groundwork**. Rationale: "understand before you build" in one English word; carries the consultancy connotation of preparatory work. Risk: common English word, crowded domains, no Finnish resonance (though understood).
3. **Workmap**. Rationale: descriptive; the report literally contains a work map (clusters by area, Mermaid process maps). Explains itself in a sentence. Risk: descriptive names are weak trademarks and there are existing products with similar names; sounds like a mapping tool more than a requirements tool.
4. **Fieldnote**. Rationale: evokes research done in the field, listening rather than pitching; works for both employee interviews and requirements interviews. Risk: existing note-taking apps use the plural; feels academic to a CTO audience.
5. **Perusta** (Finnish: "foundation", also the imperative "found/establish"). Rationale: a specification is the foundation of a build; the word is sober and institutional, suits public-sector and Finnish mid-market buyers. Risk: harder for non-Finnish speakers (pe-RUS-ta), less playful.

**Recommendation:** Askel, with "Groundwork" as the English fallback if the trademark check fails. It is the only option that works unchanged in both launch languages, says "ask" without saying "AI", and can be qualified by product ("Askel Discovery", "Askel Spec") without renaming features. Implementation is small: the `branding.productName` default, `app.name` in `en.ts`/`fi.ts`, the README title, the OpenAPI title in `apps/api/src/app.ts`, the OpenRouter `x-title`, and `apps/web/README.md`. Leave the `@aidp` package scope and `aidp-*` image names alone; renaming them buys nothing.

Whatever you choose, the tagline is fixed by the product's own principle and should appear everywhere the name does: **Understand the problem before deciding what to build.** Finnish: _Ymmärrä ongelma ennen kuin päätät, mitä rakennat._

---

## 5. Proof points to produce before launch

Each one is generated from the product itself; nothing is mocked.

1. **An anonymised sample discovery report.** Run a real campaign on your own consultancy (or a friendly client) with at least five completers so the threshold is met and k=3 bites. Use `participant_choice` so the report shows both modes work. Download Markdown from the report page, replace the campaign name, keep the method section and the "no change recommended" entries (they are the most persuasive). Publish v1 and v2 side by side with the opportunities diff from the results page to show versions. Prerequisite: fix the un-gated `evidence` snippets or hide evidence in the published copy.
2. **A sample specification bundle, built.** Run `requirements_discovery` on a small, real idea (the public landing page itself is a good candidate, or an internal tool). Export the `claude_code` bundle, then let Claude Code build it from the bundle and record the commit list referencing FR ids. Publish the bundle file tree, `PLAN.md`, one `tasks/phase-1.md`, and the v1 to v2 diff after a reopened session. Also exercise the GitHub push route once so you can claim it.
3. **Cost per interview.** From `/stats` grouped by campaign and purpose: total `costCents` for the campaign divided by completed interviews, broken down by `interview_turn`, `extraction`, `resume_summary`, and the analysis purposes amortised. Report median and p90 across the pilot sessions, and the model routes used. Caveat to fix or disclose: the ledger records zero usage for `transcribe` and models TTS as output tokens (status review), so quote a text-interview figure first, or fix the ledger before quoting voice.
4. **Time to report.** Three numbers from the database: median interview duration (session `createdAt` to completion), elapsed time from campaign open to threshold reached, and analysis duration (`Analysis.createdAt` to `finishedAt`). Present as "five interviews, X hours of participant time, report Y minutes after the fifth completion".
5. **"No leading questions" evidence.** Export one event replay from the admin session page showing each turn's `reason` and area, and the coverage progression. This is the artefact that answers the sceptic's "how do I know it asks the same things".
6. **Isolation and privacy evidence.** Point at the cross-tenant RLS test and the preflight gate in CI; publish the k-anonymity rule as it appears in the report; publish the consent default. Do this only after Tier 1 of the status review (deletion scope, rate limit identity, alerting) so the proof matches the promise.
7. **Deterministic engine evals.** Cite that the engine's coverage, focus order and widget policy are replayed in CI on fixed fixtures. Be precise: two fixtures today; the 60-turn and live-model evals are planned.

**Do not claim yet (planned or gapped):** PDF export beyond browser print; department comparison; participant data export and sub-processor list; email notifications and budget alerts; collaboration in a session; self-hosted TTS; complete participant deletion; RLS on transcripts; prompt administration UI; template rollback with one click.
