# Data processing agreement: pointer and status

**Status: draft pointer, not a contract. Counsel must review and write the legal text before any
customer signs.** Whether, and in what wording, the platform operator offers a processing
agreement is the owner's decision (decision D4 in the security plan); this file does not make it.

What this file does provide is the map from each GDPR Art. 28(3) obligation to the feature or
document that satisfies it, so that counsel works from facts about the system.

| Art. 28(3) obligation                            | Where the platform satisfies it                                                                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Process only on documented instructions      | The tenant's own configuration: templates, campaigns, settings. No use of customer data for the operator's own ends.                                                   |
| (b) Confidentiality of persons authorised        | Role-based access (admin, member, operator), audit log of administrative actions, immediate disable and delete.                                                        |
| (c) Security of processing (Art. 32)             | `docs/spec/11-security-and-privacy.md`; row-level tenant isolation, encryption of secrets at rest, key rotation, append-only hash-chained audit log, upload hardening. |
| (d) Sub-processors                               | [SUBPROCESSORS.md](SUBPROCESSORS.md), generated from the code; a tenant sees only the providers it configured.                                                         |
| (e) Assistance with data-subject requests        | Participant "Download my data" and "Delete my data"; the data inventory in `packages/core/src/privacy/inventory.ts`.                                                   |
| (f) Assistance with Art. 32 to 36 (breach, DPIA) | Alerts and runbooks in `docs/OPERATIONS.md`; the record in [PRIVACY-PROCESSING.md](PRIVACY-PROCESSING.md).                                                             |
| (g) Deletion or return at the end of the service | Retention sweep and participant deletion today. Tenant export and offboarding job: **not built** (plan A5).                                                            |
| (h) Audits and information                       | Audit log and `audit.verify` chain heads; this documentation.                                                                                                          |

Items counsel must supply that the code cannot: liability, term, governing law, the transfer
mechanism per vendor (confirm in [SUBPROCESSORS.md](SUBPROCESSORS.md)), and the controller's
consent wording (decision D4 covers both).
