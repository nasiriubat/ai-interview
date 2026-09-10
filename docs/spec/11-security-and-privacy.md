# 11 Security and privacy

- NFR-02 EU hosting; content goes only to the configured providers and the database. Data residency per tenant can select self-hosted STT and TTS and EU model endpoints.
- NFR-03 Tenant isolation: scoped client plus Postgres RLS; covered by tests that attempt cross-tenant reads.
- FR-01 to FR-04 Roles: platform_operator, admin, member; participants have no accounts; signed links with expiry; email verification for uniqueness; anonymous mode stores only a salted email hash on the campaign.
- Consent: version and timestamp per session; consent text per tenant.
- Anonymity in outputs: k-anonymity rule for quotes and breakdowns (`04`).
- Deletion: participant-initiated deletion removes messages, audio, attachments, facts, and embeddings; aggregated cluster counts remain; confirmed on screen and by email when identified. Retention period per tenant (default 24 months) with automatic deletion jobs.
- Secrets: provider keys encrypted at rest with a platform key; never returned to the browser; rotation supported.
- Transport: TLS everywhere; signed URLs for object storage; WebSocket auth by session token.
- Rate limits per participant, per tenant, per IP; abuse detection on open links.
- Audit log of admin actions and settings changes with diffs.
- Dependency and container scanning in CI; secrets scanning; least-privilege database roles (owner for migrations, app_api for the application).
- GDPR: data processing record per tenant, export of a participant's data on request, sub-processor list generated from configured providers.
