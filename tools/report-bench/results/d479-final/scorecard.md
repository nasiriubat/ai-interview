# Report bench scorecard: baseline

Scenario `kaarna-logistics` v1; graded 2026-10-21 13:43 UTC; report analysis cmvi5pefe00012wahdjtje6x8.
Judge: anthropic/claude-sonnet-5; mapping from judge (keyword cross-check agrees on 83% of items).

## Overall: 8.1 / 10

| Criterion | Weight | Score |
|---|---|---|
| Recall of planted problems | 20 | 9.6 |
| Prevalence accuracy | 12 | 9.5 |
| Ranking sensibility | 10 | 9.0 |
| Classification (incl. no-change area) | 15 | 8.6 |
| Quote fidelity | 10 | n/a |
| No hallucination | 13 | 5.0 |
| Anonymity | 10 | 7.0 |
| Actionability of next steps | 5 | 7.0 |
| Executive-summary accuracy | 5 | 6.0 |

## Ground truth against the report

| Item | Kind | Planted | Observed | Found as | Reported count | Class |
|---|---|---|---|---|---|---|
| invoice_rekeying | problem | 5 | 4 | Manual re-keying of delivery and invoice data between disconnected TMS, billing spreadsheet and Procountor; Email-to-TMS order entry with an untracked clarification backlog | 3 | automation/ai |
| approval_delays | problem | 4 | 4 | Email-based approval routing without visible request status | 4 | automation |
| shift_handover_paper | problem | 3 | 3 | Digital shift handover and consignment verification in the terminal | 3 | software |
| tachograph_compliance | problem | 1 | 1 | Undocumented compliance check with no follow-up record | 1 | process |
| shipment_status_calls | problem | 2 | 2 | Customer-facing shipment status self-service | 2 | software |
| pod_app_works | works_well | 3 | 2 | Proof-of-delivery capture working as intended, with minor on-the-spot stop issues | 3 | none |
| ai_everything | distractor | 1 | 1 | - | - | - |

## Report items

| Title | Class | Rank | Participants | Mapped to |
|---|---|---|---|---|
| Manual re-keying of delivery and invoice data between disconnected TMS, billing spreadsheet and Procountor | automation | 68.6 | 3 | invoice_rekeying |
| Email-to-TMS order entry with an untracked clarification backlog | ai | 68.6 | 3 | invoice_rekeying |
| Email-based approval routing without visible request status | automation | 65.7 | 4 | approval_delays |
| Digital shift handover and consignment verification in the terminal | software | 62.9 | 3 | shift_handover_paper |
| Manual invoice-to-delivery reconciliation and reactive detection of billing errors | automation | 60 | 2 | other_supported |
| Customer-facing shipment status self-service | software | 57.1 | 2 | shipment_status_calls |
| Verbal relay of mid-route delivery changes without a system record | software | 51.4 | 2 | other_supported |
| Manual assembly of customer documents from requested exports and emailed a tool | automation | 51.4 | 1 | other_supported |
| Undocumented compliance check with no follow-up record | process | 48.6 | 1 | tachograph_compliance |
| Missing Timing Data for Shift Activities | process | 45.7 | 1 | other_supported |
| Current scheduling overview for loading points works as is | none | 0 | 1 | other_supported |
| Proof-of-delivery capture working as intended, with minor on-the-spot stop issues | none | 0 | 3 | pod_app_works |

## Evidence

### Recall of planted problems: 9.6

- invoice_rekeying (4 people): found in "Manual re-keying of delivery and invoice data between disconnected TMS, billing spreadsheet and Procountor", "Email-to-TMS order entry with an untracked clarification backlog"; split across 2 items
- approval_delays (4 people): found in "Email-based approval routing without visible request status"
- shift_handover_paper (3 people): found in "Digital shift handover and consignment verification in the terminal"
- tachograph_compliance (1 people): found in "Undocumented compliance check with no follow-up record"
- shipment_status_calls (2 people): found in "Customer-facing shipment status self-service"

### Prevalence accuracy: 9.5

- invoice_rekeying: true 4 (planted 5), reported 3 (off)
- approval_delays: true 4 (planted 4), reported 4
- shift_handover_paper: true 3 (planted 3), reported 3
- tachograph_compliance: true 1 (planted 1), reported 1
- shipment_status_calls: true 2 (planted 2), reported 2

### Ranking sensibility: 9.0

- #1 "Manual re-keying of delivery and invoice data between disconnected TMS, billing spreadsheet and Procountor" (68.6) -> invoice_rekeying
- #2 "Email-to-TMS order entry with an untracked clarification backlog" (68.6) -> invoice_rekeying
- #3 "Email-based approval routing without visible request status" (65.7) -> approval_delays
- #4 "Digital shift handover and consignment verification in the terminal" (62.9) -> shift_handover_paper
- #5 "Manual invoice-to-delivery reconciliation and reactive detection of billing errors" (60) -> other_supported

### Classification (incl. no-change area): 8.6

- invoice_rekeying: automation/ai (accept automation/ai/software) -> ok
- approval_delays: automation (accept process/software/automation) -> ok
- shift_handover_paper: software (accept software/process/automation) -> ok
- tachograph_compliance: process (accept automation/software) -> WRONG
- shipment_status_calls: software (accept software/automation/ai) -> ok
- pod_app_works: none (accept none) -> ok
- ai_everything (distractor): not raised as an item -> ok

### Quote fidelity: n/a

- the report carries no quotes

### No hallucination: 5.0

- 0 unsupported item(s), 1 major and 4 minor unsupported claim(s)
- minor: Ten people were invited and all ten interviews were completed and analyzed, meeting the completion threshold (No transcript or data supports an 'invited' count or threshold language; likely a template artifact rather than a factual claim, but phrased as a substantive finding in the exec summary.)
- minor: about 1 hours per week in total as they described it [for email-to-TMS order entry] (P06, P08, P09 describe substantial daily time (5-8 min/order, a third of team time); aggregating to only ~1 hour/week understates and may mismatch the underlying data.)
- minor: about 8 hours per week in total [for re-keying invoice item] (Participants report 90 min/day and 3 hrs/day which sum to well over 8 hours/week; figure may not match stated per-person numbers once combined, though plausibly an averaged/computed figure not verifiable as false.)
- major: Quick wins: Undocumented compliance check with no follow-up record (rank 48.6; 1 of 10 interviews) (Labeling a single-interview, admittedly thin finding as a 'quick win' contradicts the report's own 'small sample, lead to check' caveat elsewhere and overstates confidence for action.)
- minor: This analysis covers ten interviews ... several of the ranked items were raised in only one or two interviews (Accurate as stated, but juxtaposed with the exec summary's confident framing of same low-n items as 'opportunities,' creating an internal inconsistency not itself false, borderline.)

### Anonymity: 7.0

- judge: Payroll and HR administrator being the sole person who can run the monthly tachograph check ('only she does this') (Report item 9 describes a single, identifiable role/activity from one participant in a way that could identify the one payroll/HR admin, especially combined with 'if she is on holiday nobody else could do it'.)
- judge: Reference to 'a key account manager' enthusiastic about AI with 25 accounts and HubSpot used personally (Though not included as a ranked item, if it were surfaced it would identify P10 as the sole KAM; current report avoids this by omission, but worth flagging if added later.)

### Actionability of next steps: 7.0

- Next steps name concrete starting actions (visible queue before field extraction; checking TMS export availability) and sequence the cheap check before bigger build.
- Steps 1, 2 and 4 name an owning function (operations/dispatch, finance, terminal operations) though step 3 names two owners jointly without clarifying lead.
- Sequencing is sensible (check export feasibility before automation), but there is no timeline, owner contact, or explicit dependency between steps 1-4.
- Some evidence citations in next steps (e.g. '3 of 10 interviews') are consistent with the body, supporting actionability of the rationale.

### Executive-summary accuracy: 6.0

- Correctly identifies top three/four themes (order entry, re-keying, approvals, shift handover) matching most prevalent planted problems.
- Approval routing (4 of 10) is actually the most widespread but listed third instead of first, slightly misordering by prevalence despite correct counts.
- Mentions works-well items (POD app, scheduling) but doesn't mention shipment_status_calls or tachograph_compliance as prominently despite being planted ground-truth problems, a notable omission.
- States 'ten people invited' and completion details not clearly grounded in transcripts, a minor unsupported framing device.

## Spend (USD)

- openrouter_key_delta_before_grading: 2.473
- product_ledger_this_run: 2.639
- harness_grading_this_time: 0.000

## Notes

- instance http://127.0.0.1:4290, embedding route openai/text-embedding-3-small
- simulator anthropic/claude-haiku-5.5 (temperature 0.7, seed 7)
