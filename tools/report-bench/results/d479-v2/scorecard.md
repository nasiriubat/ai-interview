# Report bench scorecard: baseline

Scenario `kaarna-logistics` v1; graded 2026-10-21 10:28 UTC; report analysis cmvhyox6100012wimldwjvrtt.
Judge: anthropic/claude-sonnet-5; mapping from judge (keyword cross-check agrees on 50% of items).

## Overall: 6.7 / 10

| Criterion | Weight | Score |
|---|---|---|
| Recall of planted problems | 20 | 7.8 |
| Prevalence accuracy | 12 | 8.0 |
| Ranking sensibility | 10 | 7.8 |
| Classification (incl. no-change area) | 15 | 8.3 |
| Quote fidelity | 10 | n/a |
| No hallucination | 13 | 2.5 |
| Anonymity | 10 | 7.0 |
| Actionability of next steps | 5 | 6.0 |
| Executive-summary accuracy | 5 | 4.0 |

## Ground truth against the report

| Item | Kind | Planted | Observed | Found as | Reported count | Class |
|---|---|---|---|---|---|---|
| invoice_rekeying | problem | 5 | 4 | Manual keying of PDF purchase invoices into the finance system; Automated extraction of order details from customer emails and attachments into a tool; Automated transfer of delivery data from a tool into billing | 2 | ai/ai/automation |
| approval_delays | problem | 4 | 4 | Manual keying of PDF purchase invoices into the finance system; Email-based invoice approval above a threshold with no status tracking; Delayed spare-part approvals extending equipment downtime; Lack of status visibility during credit note approval; Late overtime approvals arriving after the payroll cutoff | 2 | ai/automation/automation/automation/automation |
| shift_handover_paper | problem | 3 | 3 | Digital shift handover record for terminal night-to-morning status | 3 | software |
| tachograph_compliance | problem | 1 | 1 | Driving-time compliance review and violation follow-up without documented procedure or logging | 1 | process |
| shipment_status_calls | problem | 2 | 2 | Self-service shipment status instead of phone lookups | 2 | automation |
| pod_app_works | works_well | 3 | 2 | Proof-of-delivery capture via mobile app into the transport system | 3 | none |
| ai_everything | distractor | 1 | 1 | - | - | - |

## Report items

| Title | Class | Rank | Participants | Mapped to |
|---|---|---|---|---|
| Manual keying of PDF purchase invoices into the finance system | ai | 74.3 | 2 | invoice_rekeying+approval_delays |
| Automated extraction of order details from customer emails and attachments into a tool | ai | 74.3 | 2 | invoice_rekeying |
| Automated transfer of delivery data from a tool into billing | automation | 68.6 | 2 | invoice_rekeying |
| Visibility and follow-up for orders held pending customer clarification | software | 62.9 | 1 | other_supported |
| Reactive detection of outgoing invoice errors | automation | 62.9 | 2 | other_supported |
| Digital shift handover record for terminal night-to-morning status | software | 62.9 | 3 | shift_handover_paper |
| Email-based invoice approval above a threshold with no status tracking | automation | 60 | 1 | approval_delays |
| Slow resolution of flagged order-data mismatches before period close | automation | 60 | 2 | other_supported |
| Incomplete information attached to purchase approval requests | automation | 57.1 | 1 | other_supported |
| Automated reconciliation of subcontractor freight invoices against delivery records | automation | 57.1 | 1 | other_supported |
| Dependency on other a tool for figures and a tool in customer-facing documents | process | 57.1 | 1 | other_supported |
| Self-service shipment status instead of phone lookups | automation | 57.1 | 2 | shipment_status_calls |
| Standardized handling and proactive notification of delivery delays | automation | 57.1 | 2 | other_supported |
| Delayed spare-part approvals extending equipment downtime | automation | 57.1 | 1 | approval_delays |
| Lack of status visibility during credit note approval | automation | 54.3 | 1 | approval_delays |
| Paper-based verification of consignment notes against physical stock | automation | 54.3 | 1 | other_supported |
| Late overtime approvals arriving after the payroll cutoff | automation | 54.3 | 1 | approval_delays |
| Driving-time compliance review and violation follow-up without documented procedure or logging | process | 54.3 | 1 | tachograph_compliance |
| Live push of mid-route delivery changes to drivers with recorded confirmation | software | 51.4 | 1 | other_supported |
| Keying errors in manual payment entry detected only after supplier contact | automation | 51.4 | 1 | other_supported |
| Manual preparation of the monthly management report pack | automation | 48.6 | 1 | other_supported |
| Missing time records for shift activities | automation | 45.7 | 1 | other_supported |
| Monthly payroll run dependent on individual knowledge | process | 42.9 | 1 | other_supported |
| Phone-based escalation of delayed or damaged shipments | none | 40 | 1 | other_supported |
| Proof-of-delivery capture via mobile app into the transport system | none | 0 | 3 | pod_app_works |
| Daily CRM logging of customer notes and deal status for handover | none | 0 | 1 | other_supported |

## Evidence

### Recall of planted problems: 7.8

- invoice_rekeying (4 people): found in "Manual keying of PDF purchase invoices into the finance system", "Automated extraction of order details from customer emails and attachments into a tool", "Automated transfer of delivery data from a tool into billing"; split across 3 items; merged with approval_delays
- approval_delays (4 people): found in "Manual keying of PDF purchase invoices into the finance system", "Email-based invoice approval above a threshold with no status tracking", "Delayed spare-part approvals extending equipment downtime", "Lack of status visibility during credit note approval", "Late overtime approvals arriving after the payroll cutoff"; split across 5 items; merged with invoice_rekeying
- shift_handover_paper (3 people): found in "Digital shift handover record for terminal night-to-morning status"
- tachograph_compliance (1 people): found in "Driving-time compliance review and violation follow-up without documented procedure or logging"
- shipment_status_calls (2 people): found in "Self-service shipment status instead of phone lookups"

### Prevalence accuracy: 8.0

- invoice_rekeying: true 4 (planted 5), reported 2 (off)
- approval_delays: true 4 (planted 4), reported 2 (off)
- shift_handover_paper: true 3 (planted 3), reported 3
- tachograph_compliance: true 1 (planted 1), reported 1
- shipment_status_calls: true 2 (planted 2), reported 2

### Ranking sensibility: 7.8

- #1 "Manual keying of PDF purchase invoices into the finance system" (74.3) -> invoice_rekeying
- #2 "Automated extraction of order details from customer emails and attachments into a tool" (74.3) -> invoice_rekeying
- #3 "Automated transfer of delivery data from a tool into billing" (68.6) -> invoice_rekeying
- #4 "Visibility and follow-up for orders held pending customer clarification" (62.9) -> other_supported
- #5 "Reactive detection of outgoing invoice errors" (62.9) -> other_supported

### Classification (incl. no-change area): 8.3

- invoice_rekeying: ai/ai/automation (accept automation/ai/software) -> ok
- approval_delays: ai/automation/automation/automation/automation (accept process/software/automation) -> partly
- shift_handover_paper: software (accept software/process/automation) -> ok
- tachograph_compliance: process (accept automation/software) -> WRONG
- shipment_status_calls: automation (accept software/automation/ai) -> ok
- pod_app_works: none (accept none) -> ok
- ai_everything (distractor): not raised as an item -> ok

### Quote fidelity: n/a

- the report carries no quotes

### No hallucination: 2.5

- 0 unsupported item(s), 1 major and 9 minor unsupported claim(s)
- minor: Executive summary states 'Ten people were invited and all ten interviews were completed' (Participation table says 10 completed/10 analyzed; this is consistent with data, not a hallucination of fact, but phrase 'invited' is an assumed artefact — not flagged as hallucination per instructions (template artefact).)
- minor: Item 1 says invoices are opened 'one at a time' and keying takes 'a block of several hours' consuming the whole morning (P01 said ~70 invoices at ~3 min each is about 3 hours, consistent; 'several hours' is a reasonable restatement, not a hallucination.)
- minor: Item 3 states 'about 2% of deliveries end up billed wrong or late as a result of the overall manual process' (This figure is directly from P02's own estimate, so it is supported, but the report applies it to 'the overall manual process' including order-entry retyping which P02 attributed specifically to the TMS-billing-Procountor chain; borderline but not clearly false.)
- minor: Item 6 (shift handover) states reading takes 'about 25 minutes' and writing 'about 17 minutes per shift' (P04 said handover check 20-30 min and end-of-shift form 15-20 min; P05 said reading could take up to 30 min when walking; the specific numbers 25 and 17 minutes are oddly precise averages not stated by any participant verbatim, a mild embellishment.)
- major: Department comparison table: Terminal operations 4 participants, 60 hours per week (No transcript supports an aggregate figure of 60 hours/week for terminal operations; this number cannot be verified against any participant's self-reported figures and appears to be a computed artifact not traceable to stated facts.)
- minor: Department comparison table: Customer service 3 participants, 8 hours per week (Aggregated figure not clearly traceable to any single transcript statement; unclear provenance.)
- minor: Department comparison table: Finance and administration 3 participants, 16 hours per week (Aggregated figure not clearly traceable to any single transcript statement; unclear provenance.)
- minor: Item 10 text says 'The self-reported effort is about 480 minutes per week in total' (P02 described 4 working days a month on reconciliation, not an explicit weekly minutes figure; converting a monthly estimate to a precise weekly minute figure is an invented precision not stated by the participant.)
- minor: Item 12 says self-reported time is 'about 25 minutes per week in total' (No participant gave a quantified weekly time figure for status calls; P09 said calls are 'short' with no number, so this specific figure appears fabricated/derived without basis.)
- minor: Quick wins list includes 'Driving-time compliance review...' as a quick win despite the report itself describing it as 'a large and painful monthly effort' requiring written procedures (Internally inconsistent: item 18 says Simplicity 4 but text describes a heavy manual effort and organisational prerequisites, not a quick win.)

### Anonymity: 7.0

- judge: Item 3/5/8 and others reference 'a tool' repeatedly as redacted system names alongside very specific role descriptions (e.g., single controller doing month-end close, single payroll/HR administrator) that map to a single transcript (P02, P03) (Items 10, 18, 21, 23 are each based on exactly 1 participant with a distinctive enough role (sole financial controller, sole payroll/HR administrator doing tachograph checks) that colleagues could identify who was interviewed, even though names are withheld.)
- judge: Item 18 describes the tachograph compliance reviewer as the only person who knows how to do this and being away breaks the process (This level of detail (sole owner of a specific monthly task) makes the participant (P03) identifiable within a small admin team, especially combined with the 'single point of failure' framing.)

### Actionability of next steps: 6.0

- Next steps name concrete starting actions (sample mailbox, check field coverage, check if TMS has an export) and name owners like 'order intake together with IT' and 'finance and accounts payable'.
- Sequencing is sensible: cheap discovery steps before any build, aligned with report's own caveats about thin evidence.
- However, next steps only cover 3 of 26 items and ignore higher-confidence, well-evidenced items like the 3-participant shift handover problem (item 6) which has clearer support than the 2-participant top-ranked items.
- No mention of owners for verification steps in items beyond the top three; most of the 26 items get no action plan at all.

### Executive-summary accuracy: 4.0

- Leads with three 2-interview items (order email extraction, PDF invoice keying, delivery-to-billing transfer) as 'highest ranked', but these are narrower slices of the same re-keying problem and get disproportionate prominence over the 3-participant shift handover problem.
- Approval delays (a major planted problem spanning purchase, overtime, and credit notes across multiple interviews) is not mentioned as a top theme in the executive summary at all, despite being one of the most repeated patterns across P01, P03, P04, P08.
- Tachograph compliance, a clearly planted problem with serious single-point-of-failure risk, is omitted from the executive summary narrative.
- Mentions what works well (POD app, CRM logging) accurately and flags the distractor-adjacent AI caution appropriately.
- Counts given (2 of 10 interviews for top three) are accurate to the underlying data, but the thinness is itself evidence the ranking/summary over-weights sparse items.

## Spend (USD)

- openrouter_key_delta_before_grading: 2.209
- product_ledger_this_run: 2.277
- harness_grading_this_time: 0.743

## Notes

- instance http://127.0.0.1:4290, embedding route openai/text-embedding-3-small
- simulator anthropic/claude-haiku-5.5 (temperature 0.7, seed 7)
- judge samples: 3; actionability 6/6/6, executive summary 5/4/4, hallucination findings 6/10/10, unsupported items 0/0/0 (median or majority used)
