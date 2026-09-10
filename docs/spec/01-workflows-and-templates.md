# 01 Workflows and templates

## Templates are data

- FR-60 Template CRUD per tenant; platform-seeded templates can be copied and edited.
- FR-61 Template fields: key, name, objective, privacy mode (`identified`, `anonymous`, `participant_choice`), participant fields, path selection (`none`, `technical_or_not`), context block questions, coverage areas (key, name, description, done-when, per-area instructions, follow-up limit), AI instructions, adaptivity rules, widget policy, issue-detection settings, expected outputs, analysis settings, chain-to template and field mapping, closing question, end-of-session summary on or off.
- FR-62 Templates are versioned; a campaign or session pins a version; rollback is one click.
- FR-63 Preview: an admin runs a template as a throwaway session before publishing.
- FR-64 The engine reads only the template. There are no template-specific code paths.
- FR-65 Seeded templates are versioned files in the repository, loaded by migration and shown as "shipped version" in the admin UI with a diff against the tenant's edits.
- FR-66 Chaining: starting a template from another's outputs builds a hand-off object using the mapping; pre-filled sections are marked and the engine asks only what is missing.
- FR-67 Templates carry a language; prompts and UI strings are localized per language (phase 2 adds languages beyond English).

## Seeded template: `opportunity_discovery`

Objective: understand how this person's work is actually performed. Coverage areas in
order: role and responsibilities; daily activities; repetitive tasks; tools and
systems; manual processes; information flows and hand-offs; bottlenecks and waiting;
common problems; what they would change first (asked last). Rule: understand the role
before exploring the work. Follow-up policy: clarify when ambiguous; go one level
deeper when a process or a problem surfaces (recent concrete example, steps, tools,
time). Never asks where AI should be used; never suggests solutions. Outputs: facts of
kinds task, process, information_flow, pain_point, opportunity_candidate. Analysis
enabled. Chains to `requirements_discovery` with the mapping: problem, affected users,
existing process, tools, constraints, expected benefit.

## Seeded template: `requirements_discovery`

Objective: turn an idea or opportunity into an implementation-ready specification.
Path selection on the first screen: technical or nontechnical. Context block first:
hosting (none, company server, cloud account, managed platform), existing systems,
who builds (self, team, agency, coding agent), team skills, timeline, budget range,
users at launch, compliance needs. Coverage areas: product overview and problem;
target users and roles; user stories; functional requirements tagged mvp or future;
business rules; acceptance criteria; technical requirements; data requirements;
integrations; security and privacy; non-functional requirements; administrative
surface; MVP scope; future scope; implementation phases. Issue detection standard,
MVP challenge on. Interview rules: one decision per question when build impact is
high; never default a technology choice before asking what the team knows; enumerate
administrative surfaces explicitly; every question carries a default. Outputs: the
specification. Accepts hand-off from `opportunity_discovery`.

## Adding a third workflow

A new discovery process (customer research, incident retrospectives, onboarding
interviews) is a new template with its own coverage areas and outputs. If it needs a
new fact kind or output schema, that schema is registered in `packages/shared` and the
extraction prompt references it; the engine, UI, and analysis are unchanged.
