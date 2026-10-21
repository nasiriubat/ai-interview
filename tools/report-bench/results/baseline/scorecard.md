# Report bench scorecard: baseline

Scenario `kaarna-logistics` v1; graded 2026-10-21 09:38 UTC; report analysis cmvhw7jj4011c2w6od0c5o9yk.
Judge: anthropic/claude-sonnet-5; mapping from judge (keyword cross-check agrees on 62% of items).

## Overall: 6.8 / 10

| Criterion | Weight | Score |
|---|---|---|
| Recall of planted problems | 20 | 8.5 |
| Prevalence accuracy | 12 | 6.5 |
| Ranking sensibility | 10 | 8.3 |
| Classification (incl. no-change area) | 15 | 7.9 |
| Quote fidelity | 10 | 9.6 |
| No hallucination | 13 | 3.0 |
| Anonymity | 10 | 3.5 |
| Actionability of next steps | 5 | 7.0 |
| Executive-summary accuracy | 5 | 6.0 |

## Ground truth against the report

| Item | Kind | Planted | Observed | Found as | Reported count | Class |
|---|---|---|---|---|---|---|
| invoice_rekeying | problem | 5 | 4 | AI-assisted extraction of transport order details from customer emails into the TMS, with a tracked hold queue for clarifications; Manual re-keying and hand-matching of delivery data across TMS, billing spreadsheet and Procountor; Shared mailbox intake for supplier invoices and customer order emails | 3 | ai/automation/ai |
| approval_delays | problem | 4 | 4 | Untracked Email Approval Routing for Invoices Over 2,000 Euros and Spare Parts Over 500 Euros; Structured intake and deadline tracking for overtime approvals and sick-leave notices; Credit note approval delays and manual invoice error re-checking | 2 | automation/automation/automation |
| shift_handover_paper | problem | 3 | 3 | Digital shift handover record for terminal night-to-morning transfer | 3 | software |
| tachograph_compliance | problem | 1 | 1 | Single-person monthly tachograph compliance check with no violation audit trail | 3 | software |
| shipment_status_calls | problem | 2 | 2 | Customer self-service freight tracking to replace phone status enquiries | 2 | software |
| pod_app_works | works_well | 3 | 2 | Live route-change push and driver acknowledgement in the delivery app; Dock scheduling board works as intended — no action needed | 3 | software/none |
| ai_everything | distractor | 1 | 1 | AI-Generated First Drafts of Customer Offers; Speculative Cross-Team AI Assistant and Forecasting Idea | 1 | ai/none |

## Report items

| Title | Class | Rank | Participants | Mapped to |
|---|---|---|---|---|
| AI-assisted extraction of transport order details from customer emails into the TMS, with a tracked hold queue for clarifications | ai | 74.3 | 2 | invoice_rekeying |
| Manual re-keying and hand-matching of delivery data across TMS, billing spreadsheet and Procountor | automation | 68.6 | 3 | invoice_rekeying |
| Customer self-service freight tracking to replace phone status enquiries | software | 65.7 | 2 | shipment_status_calls |
| Shared mailbox intake for supplier invoices and customer order emails | ai | 65.7 | 3 | invoice_rekeying |
| Digital shift handover record for terminal night-to-morning transfer | software | 65.7 | 3 | shift_handover_paper |
| AI-Generated First Drafts of Customer Offers | ai | 62.9 | 1 | ai_everything |
| Missing validation step for invoice entries before saving | automation | 62.9 | 1 | other_supported |
| Shift-time loss from equipment failures and damaged goods at the terminal | process | 62.9 | 1 | other_supported |
| Incomplete information attached to purchase approval requests | automation | 62.9 | 1 | other_supported |
| Key account offer preparation, delay relays and monthly account reviews | process | 60 | 1 | other_supported |
| Untracked Email Approval Routing for Invoices Over 2,000 Euros and Spare Parts Over 500 Euros | automation | 60 | 2 | approval_delays |
| Single-person monthly tachograph compliance check with no violation audit trail | software | 60 | 3 | tachograph_compliance |
| Unclear retention of invoice approval emails outside Procountor | process | 57.1 | 1 | other_supported |
| Structured intake and deadline tracking for overtime approvals and sick-leave notices | automation | 57.1 | 1 | approval_delays |
| Supplier invoice discrepancy queries and at-stop route issue resolution | process | 57.1 | 2 | other_supported |
| Credit note approval delays and manual invoice error re-checking | automation | 57.1 | 2 | approval_delays |
| Supplier payment corrections from mistyped amounts and reference numbers in Procountor | automation | 57.1 | 2 | other_supported |
| On-the-spot delivery stop exceptions (missing signature or door code) | process | 54.3 | 1 | other_supported |
| Barcode scanning for pallet-to-consignment-note verification on the shift floor | automation | 54.3 | 1 | other_supported |
| Live route-change push and driver acknowledgement in the delivery app | software | 54.3 | 3 | pod_app_works |
| Forklift Breakdown Downtime and Impact Records in Terminal Maintenance Logs | none | 51.4 | 1 | unsupported |
| Daily Customer Meetings via Teams and Phone (45 Minutes, Low Pain) | none | 51.4 | 1 | other_supported |
| Monthly management report assembly in Excel and PowerPoint after close | automation | 51.4 | 1 | other_supported |
| Dock scheduling board works as intended — no action needed | none | 48.6 | 1 | pod_app_works |
| Dock worker allocation around forklift downtime from pending spare part approvals | process | 48.6 | 1 | other_supported |
| Daily pre-trip vehicle check and fuel card refuelling | none | 45.7 | 1 | other_supported |
| Speculative Cross-Team AI Assistant and Forecasting Idea | none | 42.9 | 1 | ai_everything |
| Mixed cluster: monthly payroll run for ~140 employees and the daily evening cross-dock shift | none | 34.3 | 2 | other_supported |
| No Observed Cases of Undetected Bad Information Reaching Dispatch | none | 31.4 | 1 | other_supported |

## Evidence

### Recall of planted problems: 8.5

- invoice_rekeying (4 people): found in "AI-assisted extraction of transport order details from customer emails into the TMS, with a tracked hold queue for clarifications", "Manual re-keying and hand-matching of delivery data across TMS, billing spreadsheet and Procountor", "Shared mailbox intake for supplier invoices and customer order emails"; split across 3 items
- approval_delays (4 people): found in "Untracked Email Approval Routing for Invoices Over 2,000 Euros and Spare Parts Over 500 Euros", "Structured intake and deadline tracking for overtime approvals and sick-leave notices", "Credit note approval delays and manual invoice error re-checking"; split across 3 items
- shift_handover_paper (3 people): found in "Digital shift handover record for terminal night-to-morning transfer"
- tachograph_compliance (1 people): found in "Single-person monthly tachograph compliance check with no violation audit trail"
- shipment_status_calls (2 people): found in "Customer self-service freight tracking to replace phone status enquiries"

### Prevalence accuracy: 6.5

- invoice_rekeying: true 4 (planted 5), reported 3 (off)
- approval_delays: true 4 (planted 4), reported 2 (off)
- shift_handover_paper: true 3 (planted 3), reported 3
- tachograph_compliance: true 1 (planted 1), reported 3 (off)
- shipment_status_calls: true 2 (planted 2), reported 2

### Ranking sensibility: 8.3

- #1 "AI-assisted extraction of transport order details from customer emails into the TMS, with a tracked hold queue for clarifications" (74.3) -> invoice_rekeying
- #2 "Manual re-keying and hand-matching of delivery data across TMS, billing spreadsheet and Procountor" (68.6) -> invoice_rekeying
- #3 "Customer self-service freight tracking to replace phone status enquiries" (65.7) -> shipment_status_calls
- #4 "Shared mailbox intake for supplier invoices and customer order emails" (65.7) -> invoice_rekeying
- #5 "Digital shift handover record for terminal night-to-morning transfer" (65.7) -> shift_handover_paper

### Classification (incl. no-change area): 7.9

- invoice_rekeying: ai/automation/ai (accept automation/ai/software) -> ok
- approval_delays: automation/automation/automation (accept process/software/automation) -> ok
- shift_handover_paper: software (accept software/process/automation) -> ok
- tachograph_compliance: software (accept automation/software) -> ok
- shipment_status_calls: software (accept software/automation/ai) -> ok
- pod_app_works: software/none (accept none) -> partly
- ai_everything (distractor): raised as ai/none -> WRONG

### Quote fidelity: 9.6

- 21 of 23 quotes verbatim in a participant answer
- near_verbatim (92% of words): "Päivän alussa luen yön vuoroparperin, ja sen perusteella selvitän, mitä jäi kesken."
- near_verbatim (100% of words): "because the app doesn't push route changes as far as I know"

### No hallucination: 3.0

- 1 unsupported item(s), 1 major and 4 minor unsupported claim(s)
- unsupported item "Forklift Breakdown Downtime and Impact Records in Terminal Maintenance Logs": No participant described this as a problem; it's explicitly flagged in the report itself as having no stated pain.
- minor: Barcode/label scanner tied to the shipment record (item 19) as a proposed fix for paper consignment note checking (No participant proposed or mentioned a scanner; P04 described manual paper checks only, so the scanning solution is an invented fix layered onto a real complaint.)
- minor: Item 24 labeled as dock scheduling board 'works as intended' with 0/10 severity, attributed generically (Matches P05's whiteboard scheduling comment but report frames it as a distinct major 'no action needed' theme without connecting it clearly to the POD app ground-truth works-well fact, potentially causing confusion about which system works well.)
- minor: Executive summary states 'about 2% of deliveries billed wrong or late' as part of the top opportunity framing without caveating it is one person's unmeasured estimate (This is supported by P02's statement but presented with more certainty than the self-reported/estimated nature warrants.)
- major: Item 6 (AI-generated offer drafts) presented as a real 'candidate' pain point distinct from the distractor (No participant requested AI drafting of offers as a personal problem; this stems solely from P10's general enthusiasm which ground truth explicitly flags as a distractor with no concrete pain, yet the report treats it as a separate quantifiable opportunity with its own rank and quick-win-adjacent treatment.)
- minor: Item 27 described as 'AI Assistant and Forecasting Idea' separately ranked from item 6 despite both coming from the same distractor participant (P10) (Splitting one distractor's wish-list into two separate ranked items inflates the apparent breadth of AI interest beyond what the transcript shows (one participant, one theme).)

### Anonymity: 3.5

- identifying detail appears: "only one who knows"
- judge: "she states she is the only one who knows the procedure" (tachograph item) combined with payroll/HR administrator role (Only one person holds this role and is explicitly singled out as the sole person able to perform this task, making her identifiable within a small admin team even though role name alone is generic.)
- judge: Item 10's key account manager details (Word template, HubSpot, pricing team emails, Espoo customer visit) tied to a single participant (Fewer than 3 participants in this role; specific operational details could identify the one key account manager in a small team.)
- judge: Item 25/8 terminal supervisor/worker breakdown details with very specific numbers (one hour/day, forklift idle 3-4 days) from a single participant (Combined with role (terminal night shift supervisor) this is identifiable to colleagues in a small shift team.)

### Actionability of next steps: 7.0

- Next steps name concrete fixes (TMS export check, hold queue, tachograph vendor module) tied to evidence.
- Missing clear owners (e.g., who checks the TMS export, who builds the hold queue) for each step.
- Sequencing is sensible: cheap check-the-export step before the larger integration, but approval/handover fixes aren't sequenced into the top 3.
- Does not mention the shift handover paper fix in next steps despite being a well-evidenced, cheap fix matching ground truth.

### Executive-summary accuracy: 6.0

- Correctly identifies re-keying/integration problem and tachograph single-point-of-failure as top issues, matching ground truth prevalence.
- Shift handover paper problem (a planted ground-truth item with 3 participants) is omitted from the 'three most valuable opportunities' despite being as well-supported as items it does name.
- Mentions POD app implicitly via 'seams between systems are manual' framing but does not explicitly call out POD app or dock scheduling as a clear works-well area with credit.
- Correctly flags that several single-respondent items (AI-drafted offers, chatbot) should be treated as questions not candidates, correctly identifying the distractor-adjacent risk, though it still ranks item 6 as a scored AI opportunity elsewhere.

## Spend (USD)

- product_ledger_this_run: 4.910
- harness_grading_this_time: 0.463

## Notes

- instance http://127.0.0.1:4290 (local stack, production-default OpenRouter routes: interview and extraction anthropic/claude-sonnet-5, clustering and report anthropic/claude-opus-5; lexical clustering, no embedding route)
- simulator anthropic/claude-haiku-5.5 (temperature 0.7, seed 7)
- the first grading attempt failed (the judge model spent max_tokens on hidden reasoning), so this run's OpenRouter key delta was not recorded; product spend is the bench database's LlmCall ledger; simulator spend about $0.05 by estimate
- judge samples: 3; actionability 7/6/7, executive summary 6/6/7, hallucination findings 6/5/6, unsupported items 2/1/1 (median or majority used)
