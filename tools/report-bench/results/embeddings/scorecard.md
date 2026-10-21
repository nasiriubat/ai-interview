# Report bench scorecard: baseline

Scenario `kaarna-logistics` v1; graded 2026-10-21 10:04 UTC; report analysis cmvhxv4hs00092wbqnbztpxhx.
Judge: anthropic/claude-sonnet-5; mapping from judge (keyword cross-check agrees on 58% of items).

## Overall: 6.7 / 10

| Criterion | Weight | Score |
|---|---|---|
| Recall of planted problems | 20 | 5.2 |
| Prevalence accuracy | 12 | 6.7 |
| Ranking sensibility | 10 | 8.1 |
| Classification (incl. no-change area) | 15 | 9.3 |
| Quote fidelity | 10 | 8.9 |
| No hallucination | 13 | 5.0 |
| Anonymity | 10 | 5.5 |
| Actionability of next steps | 5 | 6.0 |
| Executive-summary accuracy | 5 | 6.0 |

## Ground truth against the report

| Item | Kind | Planted | Observed | Found as | Reported count | Class |
|---|---|---|---|---|---|---|
| invoice_rekeying | problem | 5 | 4 | AI extraction of transport order details from free-text emails into the TMS; Automated PDF invoice data capture into Procountor; Integration of delivery data between TMS, billing spreadsheet and Procountor; TMS-to-finance billing data transfer without integration; TMS-to-billing-to-Procountor integration for the delivery-to-invoice chain | 2 | ai/ai/automation/automation/automation |
| approval_delays | problem | 4 | 4 | Proactive shipment status and credit note notifications to cut repeat inbound calls; Tracked invoice approval workflow for invoices above 2,000 euros; Email-based approval bottleneck for forklift spare parts above 500 euros; Late overtime approvals arriving after the payroll cutoff | 2 | automation/automation/automation/automation |
| shift_handover_paper | problem | 3 | 3 | Morning dispatch handover call based on handwritten shift sheets; Paper-Based Shift Handover Forms at Shift Boundaries; Illegible handwriting on the paper shift sheet forcing re-verification before dispatch reporting; Digital night shift handover sheet for terminal-to-planner handoff; Digital shift handover log for damaged pallets and unfinished loads; Digital shift handover record for terminal cross-dock supervisors | 1 | software/software/software/software/software/software |
| tachograph_compliance | problem | 1 | 1 | Tachograph Violation Follow-Up Without Written Procedure or Outcome Log; Automated tachograph compliance analysis replacing manual Excel review | 1 | process/automation |
| shipment_status_calls | problem | 2 | 2 | Proactive shipment status and credit note notifications to cut repeat inbound calls; Phone-based freight status lookups without customer self-service | 2 | automation/automation |
| pod_app_works | works_well | 3 | 2 | Proof-of-delivery signature and photo capture in the driver app | 3 | none |
| ai_everything | distractor | 1 | 1 | Speculative AI assistant ideas for customer service, offer drafting and cross-team handoffs | 1 | none |

## Report items

| Title | Class | Rank | Participants | Mapped to |
|---|---|---|---|---|
| AI extraction of transport order details from free-text emails into the TMS | ai | 74.3 | 2 | invoice_rekeying |
| Automated PDF invoice data capture into Procountor | ai | 71.4 | 2 | invoice_rekeying |
| Proactive shipment status and credit note notifications to cut repeat inbound calls | automation | 65.7 | 2 | shipment_status_calls+approval_delays |
| Integration of delivery data between TMS, billing spreadsheet and Procountor | automation | 65.7 | 2 | invoice_rekeying |
| Proof-of-delivery signature and photo capture in the driver app | none | 65.7 | 3 | pod_app_works |
| Ad-hoc diagnosis of delayed-order causes during status calls | process | 62.9 | 1 | other_supported |
| Proactive reconciliation of customer invoices against TMS delivery data | automation | 62.9 | 1 | other_supported |
| Incomplete information on daily purchase approval requests | automation | 62.9 | 1 | other_supported |
| Morning dispatch handover call based on handwritten shift sheets | software | 62.9 | 1 | shift_handover_paper |
| Tracked invoice approval workflow for invoices above 2,000 euros | automation | 62.9 | 1 | approval_delays |
| Automated cross-checking of order emails, Excel attachments and TMS entries | ai | 62.9 | 3 | other_supported |
| Tachograph Violation Follow-Up Without Written Procedure or Outcome Log | process | 62.9 | 1 | tachograph_compliance |
| Shift-time loss from equipment breakdowns and damaged goods | process | 60 | 1 | other_supported |
| TMS-to-finance billing data transfer without integration | automation | 60 | 1 | invoice_rekeying |
| Automated reconciliation of subcontractor freight invoices against TMS delivery records | automation | 60 | 1 | other_supported |
| Manual handling of supplier invoice reference mismatches between TMS and Procountor | automation | 60 | 2 | other_supported |
| Paper-Based Shift Handover Forms at Shift Boundaries | software | 57.1 | 1 | shift_handover_paper |
| Handheld scanning for consignment note verification against physical pallets | automation | 57.1 | 1 | other_supported |
| Phone-based freight status lookups without customer self-service | automation | 57.1 | 1 | shipment_status_calls |
| Email-based approval bottleneck for forklift spare parts above 500 euros | automation | 57.1 | 1 | approval_delays |
| Illegible handwriting on the paper shift sheet forcing re-verification before dispatch reporting | software | 57.1 | 1 | shift_handover_paper |
| TMS-to-billing-to-Procountor integration for the delivery-to-invoice chain | automation | 57.1 | 1 | invoice_rekeying |
| Digital night shift handover sheet for terminal-to-planner handoff | software | 57.1 | 1 | shift_handover_paper |
| Late overtime approvals arriving after the payroll cutoff | automation | 57.1 | 1 | approval_delays |
| Digital shift handover log for damaged pallets and unfinished loads | software | 57.1 | 1 | shift_handover_paper |
| Live route-change push from TMS to the driver proof-of-delivery app | software | 54.3 | 1 | other_supported |
| Unverified TMS export capability for finance's shipment data fields | process | 54.3 | 1 | other_supported |
| Pending-clarification orders invisible to dispatch in the TMS | software | 54.3 | 1 | other_supported |
| Automated tachograph compliance analysis replacing manual Excel review | automation | 54.3 | 1 | tachograph_compliance |
| Validation of manually entered payment amounts and reference numbers in Procountor | automation | 54.3 | 1 | other_supported |
| Phone-based delay handoff from customer service desk to key account manager | automation | 54.3 | 1 | other_supported |
| Digital shift handover record for terminal cross-dock supervisors | software | 54.3 | 1 | shift_handover_paper |
| Monthly management report assembly in Excel and PowerPoint after close | automation | 48.6 | 1 | other_supported |
| Contract renewal prep from HubSpot terms and shipment history | none | 45.7 | 1 | other_supported |
| Speculative AI assistant ideas for customer service, offer drafting and cross-team handoffs | none | 45.7 | 1 | ai_everything |
| Weekly customer offer preparation from emailed pricing tables | none | 45.7 | 1 | other_supported |

## Evidence

### Recall of planted problems: 5.2

- invoice_rekeying (4 people): found in "AI extraction of transport order details from free-text emails into the TMS", "Automated PDF invoice data capture into Procountor", "Integration of delivery data between TMS, billing spreadsheet and Procountor", "TMS-to-finance billing data transfer without integration", "TMS-to-billing-to-Procountor integration for the delivery-to-invoice chain"; split across 5 items
- approval_delays (4 people): found in "Proactive shipment status and credit note notifications to cut repeat inbound calls", "Tracked invoice approval workflow for invoices above 2,000 euros", "Email-based approval bottleneck for forklift spare parts above 500 euros", "Late overtime approvals arriving after the payroll cutoff"; split across 4 items; merged with shipment_status_calls
- shift_handover_paper (3 people): found in "Morning dispatch handover call based on handwritten shift sheets", "Paper-Based Shift Handover Forms at Shift Boundaries", "Illegible handwriting on the paper shift sheet forcing re-verification before dispatch reporting", "Digital night shift handover sheet for terminal-to-planner handoff", "Digital shift handover log for damaged pallets and unfinished loads", "Digital shift handover record for terminal cross-dock supervisors"; split across 6 items
- tachograph_compliance (1 people): found in "Tachograph Violation Follow-Up Without Written Procedure or Outcome Log", "Automated tachograph compliance analysis replacing manual Excel review"; split across 2 items
- shipment_status_calls (2 people): found in "Proactive shipment status and credit note notifications to cut repeat inbound calls", "Phone-based freight status lookups without customer self-service"; split across 2 items; merged with approval_delays

### Prevalence accuracy: 6.7

- invoice_rekeying: true 4 (planted 5), reported 2 (off)
- approval_delays: true 4 (planted 4), reported 2 (off)
- shift_handover_paper: true 3 (planted 3), reported 1 (off)
- tachograph_compliance: true 1 (planted 1), reported 1
- shipment_status_calls: true 2 (planted 2), reported 2

### Ranking sensibility: 8.1

- #1 "AI extraction of transport order details from free-text emails into the TMS" (74.3) -> invoice_rekeying
- #2 "Automated PDF invoice data capture into Procountor" (71.4) -> invoice_rekeying
- #3 "Proactive shipment status and credit note notifications to cut repeat inbound calls" (65.7) -> shipment_status_calls
- #4 "Integration of delivery data between TMS, billing spreadsheet and Procountor" (65.7) -> invoice_rekeying
- #5 "Proof-of-delivery signature and photo capture in the driver app" (65.7) -> pod_app_works

### Classification (incl. no-change area): 9.3

- invoice_rekeying: ai/ai/automation/automation/automation (accept automation/ai/software) -> ok
- approval_delays: automation/automation/automation/automation (accept process/software/automation) -> ok
- shift_handover_paper: software/software/software/software/software/software (accept software/process/automation) -> ok
- tachograph_compliance: process/automation (accept automation/software) -> partly
- shipment_status_calls: automation/automation (accept software/automation/ai) -> ok
- pod_app_works: none (accept none) -> ok
- ai_everything (distractor): raised as none -> ok

### Quote fidelity: 8.9

- 8 of 9 quotes verbatim in a participant answer
- not_found (50% of words): "Mentioned in N of M interviews"

### No hallucination: 5.0

- 0 unsupported item(s), 0 major and 10 minor unsupported claim(s)
- minor: about 1 hours per week in total as they described it (AI extraction of order details item) (No participant gave an hours-per-week figure for this task; P09 only gave a share-of-time estimate ('about a third of the team's time'), not an hours/week number.)
- minor: about 0 hours per week in total as they described it (PDF invoice capture item) (P01 reported about three hours per morning (roughly 15 hours/week), not close to 0; the displayed figure contradicts the transcript.)
- minor: Participants describe about a third of the team's time going to this retyping (Supported by P09's own estimate, but report presents it as from 'participants' plural when only one (P09) gave this figure; minor overgeneralization.)
- minor: This appeared in 2 of 10 interviews, so it is a narrow but deep pain concentrated in accounts payable (invoice capture item) (Only P01 described the PDF invoice capture task in this detail; the second interview count seems to come from loosely related mentions (P02's general description), stretching the 'participants' count.)
- minor: about 70 invoices a day consuming roughly three hours each morning (Supported directly by P01's own statement, not a hallucination but restated correctly - included for completeness, not flagged as hallucination.)
- minor: This cluster was mentioned in 2 of 10 interviews (proactive shipment status / credit note item) (Only P08 and P09 touch on status calls/credit notes tangentially; counting this as a clean 2-interview finding when the credit note detail comes from a single sentence in P08 stretches the evidence.)
- minor: Terminal operations ... 75% ... Proof-of-delivery signature and photo capture in the driver app (75%) (The department comparison table's specific percentage breakdowns are derived figures not stated by any participant verbatim; presented as precise without transcript support for the exact percentage.)
- minor: about 8 hours per week in total as they described it (TMS-to-finance billing data transfer item) (P06 reported about 90 minutes per day, i.e. roughly 7.5 hours per week, which rounds close but the report states 8 hours; minor rounding, not a major error.)
- minor: about 5 hours per week in total as they described it (Shift-time loss from equipment breakdowns) (No participant explicitly quantified weekly hours for breakdowns in a way clearly matching 5 hours/week; this appears to be an extrapolated/invented figure not directly traceable to a transcript statement.)
- minor: Facts extracted: 222 (This is a template-generated count with no way to verify against transcripts, but per instructions data artefacts of the report template are not hallucinations.)

### Anonymity: 5.5

- judge: "only one person knows how to do it... if I'm on holiday that work simply doesn't get done" tied to tachograph compliance / Payroll and HR administrator role (Describes a uniquely identifiable single role/task combination (sole person who does tachograph checks) in a report meant to protect individuals when fewer than 3 participants are behind a theme.)
- judge: References to 'the transport manager rarely replies' regarding a named single administrator's escalation emails (Narrow, single-participant anecdote about a specific interpersonal dynamic (administrator vs transport manager) that could identify the individuals involved even without naming them.)
- judge: "according to the single participant" language attached to specific role descriptions like 'evening/night shift supervisor' with specific details (12 workers, 14:00-22:00 shift) (Combined with narrow single-interview sourcing, these specific shift and headcount details could identify the individual supervisor in a small team.)

### Actionability of next steps: 6.0

- Next steps name three concrete opportunities with rationale tied to evidence (volumes, pain ratings) but no owners are specified.
- Sequencing is sensible (order entry, then invoice capture, then integration) but doesn't explicitly prioritize cheaper process fixes (e.g., approval workflow, tachograph procedure) ahead of larger AI/integration builds.
- Quick wins list mixes process fixes and automation builds without clear owner assignment, reducing actionability slightly.
- The 'Where AI is not the answer' section gives good signal on what not to build, aiding focus.

### Executive-summary accuracy: 6.0

- Leads with invoice_rekeying-related opportunities (order entry, PDF invoice capture, integration), which are prevalent in the ground truth and rightly prioritized.
- Mentions POD app as a working example appropriately.
- Omits or buries other major ground-truth problems such as approval_delays, shift_handover_paper and tachograph_compliance, which recur across many items but are not foregrounded as major themes in the summary.
- Correctly flags the distractor (AI chatbot/forecasting ideas) as unsupported speculation without a concrete problem.

## Spend (USD)

- openrouter_key_delta_before_grading: 1.901
- product_ledger_this_run: 2.148
- harness_grading_this_time: 0.000

## Notes

- instance http://127.0.0.1:4290, embedding route openai/text-embedding-3-small
- simulator anthropic/claude-haiku-5.5 (temperature 0.7, seed 7)
- judge samples: 3; actionability 6/6/6, executive summary 6/6/6, hallucination findings 6/4/10, unsupported items 0/0/0 (median or majority used)
