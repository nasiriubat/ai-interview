# Report bench scorecard: baseline

Scenario `kaarna-logistics` v1; graded 2026-10-21 10:38 UTC; report analysis cmvhz2orh00012w2yzyw72vqo.
Judge: anthropic/claude-sonnet-5; mapping from judge (keyword cross-check agrees on 75% of items).

## Overall: 8.4 / 10

| Criterion | Weight | Score |
|---|---|---|
| Recall of planted problems | 20 | 8.8 |
| Prevalence accuracy | 12 | 9.0 |
| Ranking sensibility | 10 | 9.4 |
| Classification (incl. no-change area) | 15 | 8.6 |
| Quote fidelity | 10 | 10.0 |
| No hallucination | 13 | 8.0 |
| Anonymity | 10 | 7.0 |
| Actionability of next steps | 5 | 6.0 |
| Executive-summary accuracy | 5 | 5.0 |

## Ground truth against the report

| Item | Kind | Planted | Observed | Found as | Reported count | Class |
|---|---|---|---|---|---|---|
| invoice_rekeying | problem | 5 | 4 | Manual keying of PDF invoice data into the accounting system; Manual re-keying of unstructured order details into the order system; Manual re-keying of delivery data between TMS, billing spreadsheet and Procountor | 3 | ai/ai/automation |
| approval_delays | problem | 4 | 4 | Email-Based Approval Routing Without Status Tracking or Reminders; Status Uncertainty During Credit Note Approval Driving Repeat Inbound Calls | 3 | automation/automation |
| shift_handover_paper | problem | 3 | 3 | Digital Shift Handover Record Replacing the Paper A4 Form | 3 | software |
| tachograph_compliance | problem | 1 | 1 | Manual compliance check with undefined follow-up and single-person dependency | 1 | process |
| shipment_status_calls | problem | 2 | 2 | Self-service shipment tracking and tracked follow-up for held orders | 2 | software |
| pod_app_works | works_well | 3 | 2 | Proof-of-delivery app feeding signatures and photos into the TMS | 3 | none |
| ai_everything | distractor | 1 | 1 | - | - | - |

## Report items

| Title | Class | Rank | Participants | Mapped to |
|---|---|---|---|---|
| Manual keying of PDF invoice data into the accounting system | ai | 74.3 | 2 | invoice_rekeying |
| Email-Based Approval Routing Without Status Tracking or Reminders | automation | 68.6 | 3 | approval_delays |
| Manual re-keying of unstructured order details into the order system | ai | 68.6 | 2 | invoice_rekeying |
| Self-service shipment tracking and tracked follow-up for held orders | software | 65.7 | 2 | shipment_status_calls |
| Manual re-keying of delivery data between TMS, billing spreadsheet and Procountor | automation | 65.7 | 3 | invoice_rekeying |
| Digital Shift Handover Record Replacing the Paper A4 Form | software | 62.9 | 3 | shift_handover_paper |
| Automated reconciliation of freight invoice lines against delivery records | automation | 57.1 | 3 | other_supported |
| Shift time lost to equipment breakdowns and damaged goods | process | 57.1 | 1 | other_supported |
| Late overtime approvals arriving after the payroll cutoff | automation | 57.1 | 1 | other_supported |
| Status Uncertainty During Credit Note Approval Driving Repeat Inbound Calls | automation | 54.3 | 1 | approval_delays |
| Live route-change push and confirmation for in-progress deliveries | software | 54.3 | 1 | other_supported |
| Manual compliance check with undefined follow-up and single-person dependency | process | 54.3 | 1 | tachograph_compliance |
| Manual assembly of recurring customer review reports from separate system exports | automation | 48.6 | 1 | other_supported |
| Infrequent contract renewal preparation from CRM and shipment data | none | 45.7 | 1 | other_supported |
| Waiting on shared inputs when assembling customer offers from a template | none | 45.7 | 1 | other_supported |
| Minor on-the-spot issue resolution during delivery stops | none | 42.9 | 1 | other_supported |
| Missing Activity Time Records for Shift Work | automation | 42.9 | 1 | other_supported |
| Existing scheduling overview for loading points works as intended | none | 0 | 1 | other_supported |
| Recurring monthly reporting pack assembled manually after period close | none | 0 | 1 | other_supported |
| Proof-of-delivery app feeding signatures and photos into the TMS | none | 0 | 3 | pod_app_works |

## Evidence

### Recall of planted problems: 8.8

- invoice_rekeying (4 people): found in "Manual keying of PDF invoice data into the accounting system", "Manual re-keying of unstructured order details into the order system", "Manual re-keying of delivery data between TMS, billing spreadsheet and Procountor"; split across 3 items
- approval_delays (4 people): found in "Email-Based Approval Routing Without Status Tracking or Reminders", "Status Uncertainty During Credit Note Approval Driving Repeat Inbound Calls"; split across 2 items
- shift_handover_paper (3 people): found in "Digital Shift Handover Record Replacing the Paper A4 Form"
- tachograph_compliance (1 people): found in "Manual compliance check with undefined follow-up and single-person dependency"
- shipment_status_calls (2 people): found in "Self-service shipment tracking and tracked follow-up for held orders"

### Prevalence accuracy: 9.0

- invoice_rekeying: true 4 (planted 5), reported 3 (off)
- approval_delays: true 4 (planted 4), reported 3 (off)
- shift_handover_paper: true 3 (planted 3), reported 3
- tachograph_compliance: true 1 (planted 1), reported 1
- shipment_status_calls: true 2 (planted 2), reported 2

### Ranking sensibility: 9.4

- #1 "Manual keying of PDF invoice data into the accounting system" (74.3) -> invoice_rekeying
- #2 "Email-Based Approval Routing Without Status Tracking or Reminders" (68.6) -> approval_delays
- #3 "Manual re-keying of unstructured order details into the order system" (68.6) -> invoice_rekeying
- #4 "Self-service shipment tracking and tracked follow-up for held orders" (65.7) -> shipment_status_calls
- #5 "Manual re-keying of delivery data between TMS, billing spreadsheet and Procountor" (65.7) -> invoice_rekeying

### Classification (incl. no-change area): 8.6

- invoice_rekeying: ai/ai/automation (accept automation/ai/software) -> ok
- approval_delays: automation/automation (accept process/software/automation) -> ok
- shift_handover_paper: software (accept software/process/automation) -> ok
- tachograph_compliance: process (accept automation/software) -> WRONG
- shipment_status_calls: software (accept software/automation/ai) -> ok
- pod_app_works: none (accept none) -> ok
- ai_everything (distractor): not raised as an item -> ok

### Quote fidelity: 10.0

- 3 of 3 quotes verbatim in a participant answer

### No hallucination: 8.0

- 0 unsupported item(s), 0 major and 4 minor unsupported claim(s)
- minor: Invoice approvals over 2,000 euros waiting 3 to 6 working days with weekly phone chasing on Thursday (item 2 summary) attributed consistently across 3 interviews including forklift parts (Forklift parts over 500 euros (P04) and invoice >2000 euro approvals (P01) are two different approval types merged into one flow without flagging they are separate thresholds/systems.)
- minor: Executive summary states 'Ten people were invited, ten interviews were completed' implying a 100% completion and meeting of a threshold of ten (This is a template/participation artifact, not a substantive factual claim beyond data; acceptable per instructions but flagged as borderline embellishment with 'threshold... was met' framing not grounded in any stated target.)
- minor: Item 7 description states 'about one in ten invoices does not pair cleanly' and 'template breaks when an export column moves or a new subcontractor appears' as established facts (P02 explicitly says these are rough estimates/guesses ('I don't track the exact share anywhere, so treat that one-in-ten as an estimate'), presented in report without that caveat in the item text itself (though caveated elsewhere in report).)
- minor: Item 8 'a single incident can consume roughly an hour' presented as established data point class Process with Impact 3 (P04 gives this as a rough memory-based estimate ('I don't have exact timings logged... from memory'), reasonably supported but borderline over-precise framing.)

### Anonymity: 7.0

- judge: Tachograph check item (item 12) describes 'about two days a month... only she does this' in ground truth and report text implies single-person dependency with gendered reference in underlying transcript (With only 1 participant behind this finding and a unique 'sole administrator' role, this could identify the payroll/HR administrator in a small org.)
- judge: Item 9 overtime approvals 'payroll cutoff' tied to 1 interview (Single-participant finding tied to a specific administrative function could identify the payroll/HR administrator.)

### Actionability of next steps: 6.0

- Next steps name concrete scoping actions (PDF extraction, order extraction, approval workflow) with some owners ('finance with IT support', 'order entry and customer service')
- Sequencing is sensible: cheaper requirements-discovery steps before larger builds, prioritizing based on rank
- But two of the three next steps rest on 2-interview 'small sample' findings promoted to top priority ahead of the 3-interview approval delay issue, which is actually listed third despite broader support
- No next step addresses the shift handover paper problem or tachograph compliance despite being well-evidenced ground-truth problems

### Executive-summary accuracy: 5.0

- Leads with two 2-interview AI items (invoice keying, order keying) ranked above the 3-interview approval delays, shift handover, and delivery re-keying issues, despite the latter having stronger evidence and quantified impact (2% billing errors, 90 min/day).
- Mentions approval routing issue with correct concrete detail (3-6 day waits, forklift down).
- Does correctly flag thin evidence caveat on top two items.
- Mentions POD app works-well correctly but omits that the shift handover and delivery-rekeying problems (also 3-interview, strong evidence) are arguably more prevalent/impactful than the top-ranked 2-interview AI items, understating true top problems.

## Spend (USD)

- openrouter_key_delta_before_grading: 2.363
- product_ledger_this_run: 2.724
- harness_grading_this_time: 0.383

## Notes

- instance http://127.0.0.1:4290, embedding route openai/text-embedding-3-small
- simulator anthropic/claude-haiku-5.5 (temperature 0.7, seed 7)
- judge samples: 3; actionability 6/6/6, executive summary 6/5/5, hallucination findings 6/4/4, unsupported items 0/0/0 (median or majority used)
