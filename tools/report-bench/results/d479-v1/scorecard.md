# Report bench scorecard: baseline

Scenario `kaarna-logistics` v1; graded 2026-10-21 10:19 UTC; report analysis cmvhyemm300012w9i3sfw2mch.
Judge: anthropic/claude-sonnet-5; mapping from judge (keyword cross-check agrees on 72% of items).

## Overall: 6.0 / 10

| Criterion | Weight | Score |
|---|---|---|
| Recall of planted problems | 20 | 5.3 |
| Prevalence accuracy | 12 | 6.2 |
| Ranking sensibility | 10 | 7.9 |
| Classification (incl. no-change area) | 15 | 8.8 |
| Quote fidelity | 10 | 0.0 |
| No hallucination | 13 | 7.0 |
| Anonymity | 10 | 7.0 |
| Actionability of next steps | 5 | 5.0 |
| Executive-summary accuracy | 5 | 4.0 |

## Ground truth against the report

| Item | Kind | Planted | Observed | Found as | Reported count | Class |
|---|---|---|---|---|---|---|
| invoice_rekeying | problem | 5 | 4 | Manual keying of PDF supplier invoices into the finance system; Automated extraction of order details from customer emails into the transport management system; Repeated manual re-keying of delivery data between operational and billing systems; Manual transfer of completed shipment data into the finance billing file; Manual re-keying in the delivery-to-invoice data chain; Consistency check of order details between email text and attached spreadsheet; Validation of manually keyed amounts and reference numbers; Manual re-keying of freight invoice data and unclear notification of corrections in the finance system | 2 | ai/ai/automation/automation/automation/ai/automation/process |
| approval_delays | problem | 4 | 4 | Manual keying of PDF supplier invoices into the finance system; Email-based invoice approval routing without status tracking; Email-based spend approval delaying equipment repairs; Late overtime approvals arriving after the payroll cutoff | 1 | ai/automation/automation/automation |
| shift_handover_paper | problem | 3 | 3 | Digital shift handover record instead of a a tool; Paper-based shift handover forms at shift boundaries; Paper-based night shift handover requiring a daily phone call; Illegible handwriting on the paper shift handover sheet; Daily verbal shift handover of outstanding loads based on a handwritten sheet; Reconstructing missing shift handover information by walking the terminal | 1 | software/software/automation/software/software/software |
| tachograph_compliance | problem | 1 | 1 | Manual tachograph data review and compliance check dependent on individual knowledge; Undocumented follow-up on driving-time violation findings | 1 | automation/process |
| shipment_status_calls | problem | 2 | 2 | Customer self-service freight status and tracking of held orders; Inbound shipment status enquiries handled by phone; Manual status lookups for customer shipment enquiries | 2 | software/automation/automation |
| pod_app_works | works_well | 3 | 2 | Proof-of-delivery capture via app with direct transfer into the transport system | 3 | none |
| ai_everything | distractor | 1 | 1 | Waiting on a tool when assembling customer offers | 1 | none |

## Report items

| Title | Class | Rank | Participants | Mapped to |
|---|---|---|---|---|
| Manual keying of PDF supplier invoices into the finance system | ai | 74.3 | 1 | invoice_rekeying+approval_delays |
| Automated extraction of order details from customer emails into the transport management system | ai | 68.6 | 2 | invoice_rekeying |
| Unstandardized diagnosis of delayed-order status enquiries | process | 65.7 | 1 | other_supported |
| Reactive detection of outgoing invoice errors | automation | 65.7 | 1 | other_supported |
| Email-based invoice approval routing without status tracking | automation | 65.7 | 1 | approval_delays |
| Repeated manual re-keying of delivery data between operational and billing systems | automation | 62.9 | 1 | invoice_rekeying |
| Customer self-service freight status and tracking of held orders | software | 62.9 | 1 | shipment_status_calls |
| Manual transfer of completed shipment data into the finance billing file | automation | 62.9 | 1 | invoice_rekeying |
| Digital shift handover record instead of a a tool | software | 62.9 | 1 | shift_handover_paper |
| Inbound shipment status enquiries handled by phone | automation | 62.9 | 2 | shipment_status_calls |
| Paper-based shift handover forms at shift boundaries | software | 60 | 1 | shift_handover_paper |
| Pending-clarification orders remain outside the a tool and invisible to planning | automation | 60 | 1 | other_supported |
| Incomplete information attached to purchase approval requests | automation | 60 | 1 | other_supported |
| Manual re-keying in the delivery-to-invoice data chain | automation | 60 | 1 | invoice_rekeying |
| Consistency check of order details between email text and attached spreadsheet | ai | 60 | 1 | invoice_rekeying |
| Manual status lookups for customer shipment enquiries | automation | 57.1 | 1 | shipment_status_calls |
| Email-based spend approval delaying equipment repairs | automation | 57.1 | 1 | approval_delays |
| Paper-based night shift handover requiring a daily phone call | automation | 57.1 | 1 | shift_handover_paper |
| Delayed clarification of order data mismatches with operations at period close | automation | 57.1 | 2 | other_supported |
| Manual re-routing of in-progress deliveries after customer changes | software | 54.3 | 1 | other_supported |
| Unverified export capability of the a tool for finance's required fields | process | 54.3 | 1 | other_supported |
| Monthly account review pack assembled from manually requested operational exports | automation | 54.3 | 1 | other_supported |
| Illegible handwriting on the paper shift handover sheet | software | 54.3 | 1 | shift_handover_paper |
| Late overtime approvals arriving after the payroll cutoff | automation | 54.3 | 1 | approval_delays |
| Rule-based reconciliation of subcontractor freight invoices against delivery records | automation | 54.3 | 1 | other_supported |
| Validation of manually keyed amounts and reference numbers | automation | 54.3 | 2 | invoice_rekeying |
| Mid-shift interruptions from equipment failures and damaged goods | process | 51.4 | 1 | other_supported |
| Daily verbal shift handover of outstanding loads based on a handwritten sheet | software | 51.4 | 1 | shift_handover_paper |
| Manual tachograph data review and compliance check dependent on individual knowledge | automation | 51.4 | 1 | tachograph_compliance |
| Phone-based handover of delivery delay notifications to account management | automation | 51.4 | 1 | other_supported |
| Undocumented follow-up on driving-time violation findings | process | 51.4 | 1 | tachograph_compliance |
| Manual re-keying of freight invoice data and unclear notification of corrections in the finance system | process | 51.4 | 2 | invoice_rekeying |
| Reconstructing missing shift handover information by walking the terminal | software | 48.6 | 1 | shift_handover_paper |
| Paper-only verification of consignment notes against physical stock | automation | 48.6 | 1 | other_supported |
| Waiting on a tool when assembling customer offers | none | 45.7 | 1 | ai_everything |
| Proof-of-delivery capture via app with direct transfer into the transport system | none | 0 | 3 | pod_app_works |

## Evidence

### Recall of planted problems: 5.3

- invoice_rekeying (4 people): found in "Manual keying of PDF supplier invoices into the finance system", "Automated extraction of order details from customer emails into the transport management system", "Repeated manual re-keying of delivery data between operational and billing systems", "Manual transfer of completed shipment data into the finance billing file", "Manual re-keying in the delivery-to-invoice data chain", "Consistency check of order details between email text and attached spreadsheet", "Validation of manually keyed amounts and reference numbers", "Manual re-keying of freight invoice data and unclear notification of corrections in the finance system"; split across 8 items; merged with approval_delays
- approval_delays (4 people): found in "Manual keying of PDF supplier invoices into the finance system", "Email-based invoice approval routing without status tracking", "Email-based spend approval delaying equipment repairs", "Late overtime approvals arriving after the payroll cutoff"; split across 4 items; merged with invoice_rekeying
- shift_handover_paper (3 people): found in "Digital shift handover record instead of a a tool", "Paper-based shift handover forms at shift boundaries", "Paper-based night shift handover requiring a daily phone call", "Illegible handwriting on the paper shift handover sheet", "Daily verbal shift handover of outstanding loads based on a handwritten sheet", "Reconstructing missing shift handover information by walking the terminal"; split across 6 items
- tachograph_compliance (1 people): found in "Manual tachograph data review and compliance check dependent on individual knowledge", "Undocumented follow-up on driving-time violation findings"; split across 2 items
- shipment_status_calls (2 people): found in "Customer self-service freight status and tracking of held orders", "Inbound shipment status enquiries handled by phone", "Manual status lookups for customer shipment enquiries"; split across 3 items

### Prevalence accuracy: 6.2

- invoice_rekeying: true 4 (planted 5), reported 2 (off)
- approval_delays: true 4 (planted 4), reported 1 (off)
- shift_handover_paper: true 3 (planted 3), reported 1 (off)
- tachograph_compliance: true 1 (planted 1), reported 1
- shipment_status_calls: true 2 (planted 2), reported 2

### Ranking sensibility: 7.9

- #1 "Manual keying of PDF supplier invoices into the finance system" (74.3) -> invoice_rekeying
- #2 "Automated extraction of order details from customer emails into the transport management system" (68.6) -> invoice_rekeying
- #3 "Unstandardized diagnosis of delayed-order status enquiries" (65.7) -> other_supported
- #4 "Reactive detection of outgoing invoice errors" (65.7) -> other_supported
- #5 "Email-based invoice approval routing without status tracking" (65.7) -> approval_delays

### Classification (incl. no-change area): 8.8

- invoice_rekeying: ai/ai/automation/automation/automation/ai/automation/process (accept automation/ai/software) -> partly
- approval_delays: ai/automation/automation/automation (accept process/software/automation) -> partly
- shift_handover_paper: software/software/automation/software/software/software (accept software/process/automation) -> ok
- tachograph_compliance: automation/process (accept automation/software) -> partly
- shipment_status_calls: software/automation/automation (accept software/automation/ai) -> ok
- pod_app_works: none (accept none) -> ok
- ai_everything (distractor): raised as none -> ok

### Quote fidelity: 0.0

- 0 of 1 quotes verbatim in a participant answer
- not_found (50% of words): "Mentioned in N of M interviews"

### No hallucination: 7.0

- 0 unsupported item(s), 0 major and 6 minor unsupported claim(s)
- minor: Executive summary states proof-of-delivery was described as working well in 3 of 10 interviews (This is accurate per transcripts (P04, P05 references POD indirectly, P06 explicitly) — actually supported, listing only to note it was checked; not a hallucination, removing.)
- minor: Item 10 and item 16 both claim shipment status calls are a daily task with 'no pain reported' (P08 and P09 describe status calls as contributing to workload pressure and busy mornings, which is at least mild pain, so calling it 'no pain reported' understates the transcript evidence.)
- minor: Item 7 describes 'orders that cannot be entered because they await customer clarification are tracked by hand' (P08 describes holding orders and keeping track mentally/manually but the report frames this as an established formal tracking system, an embellishment beyond what was described.)
- minor: Executive summary implies the three invoice/order themes are 'the picture that emerges' representing the overall organization (Given almost every opportunity rests on just 1-2 of 10 interviews, describing this as 'the picture' overstates organizational breadth despite caveats elsewhere.)
- minor: Item 25 'Rule-based reconciliation of subcontractor freight invoices' — reported effort 'about 8 hours per week in total' (P02 describes reconciliation taking the first four working days of the month, not a weekly figure; converting a monthly, multi-day task into a clean 8-hours/week figure is an extrapolation not stated by the participant.)
- minor: Item 21 implies the export capability check is 'reported by a single participant' about the 'a tool' used for billing specifically to finance (P06 raised this uncertainty about the TMS export, but the item text anonymizes to 'a tool' in a way that slightly obscures which system is referenced, a minor clarity/accuracy issue rather than fabrication.)

### Anonymity: 7.0

- judge: Tachograph check described as done by a single named-role person ('only she does this' per ground truth) with details like 'the person reporting the violations' and '2 days a month' - report item 29/31 describe a single payroll/HR administrator's unique task (Only one person performs this role; describing the exact workflow and her solo responsibility could let colleagues identify P03 even though report withholds quotes.)
- judge: Item 35's reference to a key account manager's AI enthusiasm without pain, tied to a single participant's offer-prep routine (Distractor role (key account manager) is likely held by very few people; combined with specific details (HubSpot, Word template, 25 accounts) this could identify P10 even without a quote.)

### Actionability of next steps: 5.0

- Next steps name specific opportunities (PDF invoice keying, order extraction, approval routing) but do not assign named owners beyond generic 'finance function' or 'customer service', and sequencing (requirements discovery before build) is reasonable but vague on timeline.
- Steps 1-3 all rest on single-interview or two-interview evidence, which the report itself flags as thin, undermining confidence in acting on them as top priorities.
- No next step addresses the higher-volume, more operationally central problems like shift handover paper (raised across multiple roles: P04, P05, P06) or tachograph compliance risk, despite these being arguably more urgent (compliance, single point of failure).
- Quick wins list is generic process/approval fixes without concrete sequencing against the 'strategic bet' (PDF invoice OCR), though at least cheap-fix-first logic is implicit.

### Executive-summary accuracy: 4.0

- Leads with 'manual keying of PDF supplier invoices', an n=1 finding, ahead of shift handover paper problems that recur across at least 4 interviews (P04, P05, P06, and related items 9/11/18/23/28/33), understating the most broadly-evidenced theme.
- Does not mention tachograph compliance risk (a planted, serious single-point-of-failure compliance problem) at all in the executive summary.
- Mentions POD app correctly as working well with accurate count (3 of 10).
- Correctly flags thin evidence/breadth caveats for the top two ranked items, which is honest, but this undercuts rather than supports leading with them as 'highest-ranked'.

## Spend (USD)

- openrouter_key_delta_before_grading: 2.215
- product_ledger_this_run: 2.375
- harness_grading_this_time: 0.508

## Notes

- instance http://127.0.0.1:4290, embedding route openai/text-embedding-3-small
- simulator anthropic/claude-haiku-5.5 (temperature 0.7, seed 7)
- judge samples: 3; actionability 5/5/5, executive summary 4/4/4, hallucination findings 6/7/5, unsupported items 0/0/0 (median or majority used)
