# Marketing demo, October 2026

Two end-to-end demo cases run on the real app (web, API, worker, Postgres, a real model through
OpenRouter), with screenshots and a voice-over. Everything here is fictional: the company
("Harbourline Clinics"), the nine colleagues, the data. The colleagues are language-model
simulators from the live-run harness, so every number below is a **test figure**, not a result
from real people.

```
screenshots/   index.md says what each picture shows and the best moment to use it
voiceover/     script.txt (cues and legend), script-plain.txt, script.srt (178 s), script-60s.srt
tooling/       the shell wrappers used to run the stack (paths are session scratch, see "Re-recording")
```

## What was run

|                                             |                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date                                        | 2026-10-14, localhost only                                                                                                                                                                                                                        |
| Stack                                       | `node apps/api/dist/server.js` on 4110, `apps/worker/dist/main.js`, `next start` on 3200, database `ai_discovery_demo` on the dev Postgres container                                                                                              |
| Provider                                    | OpenRouter through the platform provider the bootstrap creates; the key was read by the harness from the git-ignored `.env` at run time and handed to child processes through their environment. It is in no file, log, screenshot or commit here |
| Models (routes the harness picked by price) | `anthropic/claude-haiku-5.5` for interview turns, `mistralai/mistral-small-3.2-24b-instruct` for extraction and summaries, `openai/gpt-4.1-mini` for clustering, report and specification. Simulated people: `qwen/qwen3-30b-a3b-instruct-2507`   |
| Tenant budget                               | 2.00 set through the budget feature (the run needed 0.48)                                                                                                                                                                                         |

**Case 1, discovery.** Campaign "Where does our time go? Clinic network discovery", template
`opportunity_discovery`, participant's own choice of named or anonymous. Ten interviews completed
across three departments (front desk 3, billing 3, nursing 4): eight over the API with the
simulator, two taken in a real browser with Playwright typing the simulator's answers (the first
browser run could not capture its end screen, so a second one was taken). The brief asked for
three interviews; nine-plus were needed because the department comparison only shows a group of
three or more, and three interviews in three departments would have shown nothing but
"withheld". Each interview ended at 16 assistant turns (the campaign cap was 14). Analysis:
288 extracted items, 25 groups (word matching, no embedding route), 1 AI, 17 automation, 3 software
and 4 process or no-change opportunities. Report: 17-page PDF.

**Bridge.** The opportunity "Digital Inventory Tracking System for Stock Counting and Restocking"
was promoted into a requirements interview with the product's own handoff (40 fields filled,
9 sections, "From discovery"). It ran 33 turns and generated version 1.

**Case 2, requirements.** "Parking Pass", one sentence of idea, a nontechnical owner. 33 turns, a
read-back of the list, one finding raised (a reminder at 4:30 PM that conflicts with an alert at
6:30 PM, shown as still open). Version 1, then reopened for 5 more turns and version 2: 9
requirements (8 MVP, 1 future), 16 sections. Diff v2 against v1: 6 requirements added, 2 removed, 3
changed, 4 sections changed. Exports: PDF (12 pages), Markdown, JSON, and the agent bundle
(`CLAUDE.md`, `AGENTS.md`, `PLAN.md`, `tasks/phase-1.md`, five `.mmd` diagrams, `spec.md`,
`spec.json`).

## Cost

Product ledger for the whole run: **48.0 cents** (interview turns 21.9, report 17.8, extraction
3.9, specification 2.6, clustering 1.4, other 0.5). Simulated people and the browser
simulator cost about 5 cents more outside the ledger (the harness reported 2.4 cents for the
first eight interviews, 1.7 for the requirements runs, plus the browser ones). Total under 0.60 USD against a 3 USD cap.
Completed discovery interviews cost 1.39 to 1.87 cents each in model usage (mean 1.6); that is
in line with the 1.4 to 2.2 cents on the landing page and the same kind of figure: a test run
with simulated colleagues and low-cost models.

## What to re-record

- **The end of the browser interview (case1 08).** The script's last simulated answer was typed
  into the summary box because the page had moved on to the summary, so the box holds
  "No, that's accurate. You've captured the rhythm of the day..." instead of the generated
  summary. It reads plausibly, but record it again with a real pause at the summary, or edit the
  box by hand first. The "What was noted" list below it repeats near-identical items ("prepare
  clinic room for next patient" four times); that is a real property of the extraction.
- **Diagrams.** Only the sequence diagram renders legibly (see defects). Re-shoot context,
  container and entity diagrams once that is fixed; the voice-over does not rely on them.
- **Voice screen.** No screenshot of the voice mode: it needs a participant session and was never
  run against a real realtime provider (claims inventory: Partial). Only the Voice button in the
  mobile chat is visible.
- **Analysis progress (case1 10).** A queued banner caught after pressing "Analyze now"; a longer
  run would give a better frame.
- **Operator health (ops 01).** Looks like a dev stack: warning, backup "Never". Re-shoot on a
  production-like stack or leave it out.
- **Anything with the staff address.** Sidebar shows `live-admin@example.test`.

Running it again: the wrappers in `tooling/` expect a scratch directory
`/private/tmp/claude-504/d` (a symlink to the session scratchpad; change the paths). In order:
`run-stack.sh` (needs `pnpm build`, `pnpm db:up`, free ports 4110 and 3200), `start-web.sh`,
`run-disc.sh`, then in `apps/web`: `pnpm exec tsx demo/demo-a.ts` (moved out of `scripts/`, which the web image type-checks and cannot see `scripts/live-run`) (landing and the browser
interview), `run-analysis.sh`, `run-req.sh`, and `demo-b.ts`, `demo-c.ts`, `demo-d.ts`,
`demo-e.ts`, `demo-f.ts` for the staff screens. The PDFs were rendered to PNG with PyMuPDF.

## Candid list: what did not work, looked bad, or errored

Product defects found (none fixed in this folder; items 1 to 4, 7 and the end-screen part of the re-record list were fixed afterwards, see `docs/discovery/decisions.md` D-320 to D-326, and the diagram cause was reduced motion, not CSP):

1. **Flowchart diagrams are illegible.** In the version page and in the workspace, the context,
   container and entity-relationship diagrams are drawn with a viewBox thousands of units wide
   (16,528 by 16,439 for one), so the boxes and text are a few pixels high inside a 681 px
   column, with large blank space around them. Sequence diagrams are fine. The specification PDF
   export logs the same three diagrams as `diagram_unrendered` warnings in the audit log and
   renders without them. Likely a Mermaid layout or text-measure problem under the enforced CSP
   (the page is served in production mode); not diagnosed. Check before any claim about diagrams
   in a video: "editable diagrams" is true, "readable diagrams" is not demonstrated.
2. **Department panel clips its text.** In the results sidebar, "Described by many: ..." runs off
   the right edge of the card (case1 15). In the report, the "Most shared" column of the
   department table is a narrow strip with one word per line (case1 18).
3. **MVP challenge shows "Not started"** on both completed requirements interviews, although the
   interview ended by its own engine.
4. **Cost labelled in euros.** The overview and budget show EUR; the provider prices were
   entered in USD per million tokens from OpenRouter's list. The unit is a label, not a
   conversion, so the figures are cents of whichever currency the price table is in. Say
   "about half a euro or dollar" if quoted, or fix the label.
5. **Extraction repeats itself.** The participant's "What was noted" has near-duplicates, and
   the report has 25 groups from 288 items with some overlapping titles (for example two
   automation themes about room preparation). Embeddings were not configured (OpenRouter serves
   none), so grouping used word matching; this is the Partial row in the claims inventory.
6. **Invented detail.** The simulator invented a refrigerator-temperature check and one theme
   from it was ranked 65.7. Real interviews would not have it; do not read the ranking as
   meaningful.
7. **Several analysis versions.** Versions 1 and 2 existed before the one I started on settled
   facts (3), most likely queued automatically at the completion threshold while extraction was
   still finishing (not verified); a fourth was started for the progress screenshot. The report v3 is the one in the PDF. A campaign owner who
   watches the screen will see versions appear.
8. **Report wording.** "about 1 hours per week" (singular/plural) in a withheld-group line.
9. **Header layout** of the landing page at 1440 px wraps its controls to a second row.
10. **Interview length** is 16 turns, not the "20 to 24" the landing FAQ quotes; that FAQ figure
    is from earlier test runs. Not wrong, but do not narrate 20 to 24 over
    these screens.
11. **Requirements reopen** needed an explicit second pass of turns; there is no "just regenerate"
    path, which is correct but slower on camera.

Environment and process problems:

12. **Port 4100 was already taken** by another session's API, so the first stack start died with
    `EADDRINUSE` and the harness then got 401s from the other process. Moved to 4110.
13. **The first browser interview could not be captured at its end** (script bug: waited for a
    Send button that is replaced by the summary). Its session exists as a completed interview;
    that is why there are ten completed interviews and why one of the nursing group is a
    duplicate persona.
14. **The harness's simulator prompt and tenant name were hard-coded** for a hospital group. Two
    small env-driven changes were made in `scripts/live-run` (`LIVE_ORG_DESCRIPTION`,
    `LIVE_TENANT_NAME`); defaults are unchanged.

## Truthfulness notes for the voice-over

Every product sentence in `voiceover/script.txt` is a Built row of
`docs/team/claims-2026-10.md` (same interview from a fixed template version, answer options,
no account for participants, participant-editable summary, k-anonymity at three, report as
PDF, "no change recommended", opportunity to requirements bridge, numbered requirements with
acceptance criteria, versions with a diff, agent bundle, ledger of model calls, English and
Finnish). Not said anywhere: voice interviews, GitHub push, SSO, integrations, certifications,
any customer, any price, any time saved. The ending states that the colleagues were simulated.
The one comparison with a chatbot follows the landing page's own table, including what a chatbot
does as well. Numbers spoken: ten colleagues, three departments, 288 items, 25 themes, "at least
three people". All come from this run.
