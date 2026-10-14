# 05 Requirements interview

## Start

- FR-20 Starts from free text, attachments, a hand-off from discovery, or an external invitation link (`06`). Path selection first, then the context block (`02`).
- FR-21 Each question states why it matters and offers a default; one high-impact decision per question.

## Issue detection (FR-21b)

Runs every five turns (knob) and at completion, as a separate pass over the spec state.
Finding types: `ambiguity`, `contradiction`, `missing_decision`, `over_complexity`.
Each finding has a spec location, a plain description, a proposed resolution, and a
default. Findings are raised one at a time in the conversation, phrased for the path,
and listed in a side panel. Outcomes: resolved, accepted as is, deferred to future
scope. When the user rejects a finding the engine is confident about, it pushes back
once with the concrete consequence, then records the user's choice.

Aggressiveness (knob): gentle (contradictions and missing decisions only), standard
(all four, at most one per five turns), strict (challenge every MVP item). Nontechnical
path defaults to gentle on technical findings and standard on the rest.

## MVP challenge (FR-22a)

Every functional requirement is tagged mvp or future as captured. Before finalizing,
the engine walks the MVP list once and asks, for each item not traced to the core
problem, "If version one shipped without this, what breaks?" Items move to future scope
with the reason or stay with the reason. The user can end the challenge early. The
MVP section lists what is in, what moved out and why, and what comes next.

## Live specification (FR-22, FR-23)

Rendered from structured state after each turn; the owner edits any section directly
and edits are authoritative; diagrams (Mermaid) are sections too.

Diagrams are edited one by one (D-214 to D-216). The owner may rewrite the Mermaid source
of a generated diagram, add a diagram of their own, or put the generated one back. A
diagram has a title, a kind (context, containers, sequence, state, entity) and a required
description, which is its caption and its alt text. The editor shows a live preview as the
owner types. On save the source is checked: at most 20 KB, a known diagram type, and no
directives, `click` actions, HTML (other than `<br>` and emphasis), scripts or remote
resources; then the renderer's own parser is asked, and a refusal comes back with its
line. When the renderer cannot be reached the edit is kept and marked not verified. An
edit is a `diagram:<key>` entry in the session's spec edits, laid over the generator's
diagrams on every regeneration, so it is never overwritten.

## Specification sections

Product overview and problem; target users and roles; user stories; functional
requirements (id, mvp or future, acceptance criteria); business rules; technical
requirements (specified or recommended, with alternatives considered); data
requirements with an entity diagram; integrations; security and privacy;
non-functional requirements; administrative surface; MVP scope; future scope;
implementation phases (each phase: goals, tasks, dependencies, acceptance); open
questions with the default taken; diagrams: context, containers, key sequences, state.

## Outputs and exports (FR-24 to FR-26)

`spec.md` human-readable; `spec.json`; agent bundle: `AGENTS.md` context, `PLAN.md`
phases, one task file per phase with acceptance, formatted for Codex or Claude Code
(knob). Export by download, PDF (Kroki-rendered diagrams), or push to a GitHub
repository. Versions kept; reopening creates a new version with a diff.

Every format carries the same document (D-219): `spec.md` has a `###` heading, the
caption and a ` ```mermaid ` fence per diagram, `spec.json` has them in `diagrams`, the
bundle has one `diagrams/<key>.mmd` file per diagram beside `spec.md`, and the PDF draws
them. The PDF is `GET /requirements/:id/versions/:v/export?format=pdf` (also
`.../export.pdf`): a cover with the product name, title and version label, a table of
contents of the section headings, in the order of the document, and the
header, footer, tables and code blocks of the report PDF. Tests compare the formats by
structure (`packages/core/test/export-fidelity.test.ts`) so a section cannot be dropped
from one of them unnoticed.

## Collaboration (later phase)

The owner can invite a second person into a session; both see the same spec; the
engine addresses questions to the person best placed to answer.

## Admin knobs (ADM-REQ)

Cadence, aggressiveness per path, finding types enabled, context block questions, MVP
challenge mandatory or optional, section list and order, bundle format, diagram types.
