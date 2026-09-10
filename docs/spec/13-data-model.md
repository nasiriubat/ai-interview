# 13 Data model

Extends the schema in `packages/db/prisma/schema.prisma` (phase 1 adds the rows marked new).

```mermaid
erDiagram
  Company ||--o{ User : has
  Company ||--o{ InterviewTemplate : owns
  Company ||--o{ Campaign : runs
  Company ||--o{ Provider : configures
  Company ||--o{ Route : overrides
  Company ||--o{ Budget : sets
  Company ||--o{ Setting : sets
  InterviewTemplate ||--o{ Campaign : instantiates
  Campaign ||--o{ Invitation : sends
  Campaign ||--o{ Participant : has
  Campaign ||--o{ Session : contains
  Campaign ||--o{ Analysis : produces
  Participant ||--o{ Session : takes
  Session ||--o{ Message : has
  Session ||--o{ SessionEvent : logs
  Session ||--o{ Attachment : holds
  Session ||--o{ Fact : yields
  Session ||--o{ SpecVersion : versions
  Analysis ||--o{ Opportunity : finds
  Analysis ||--o{ Report : writes
  Opportunity ||--o{ OpportunityEvidence : cites
  Fact ||--o{ OpportunityEvidence : supports
  Provider ||--o{ ModelPrice : prices
  Provider ||--o{ Route : serves
  Company ||--o{ LlmCall : spends
  Company ||--o{ AuditLog : records
```

New or changed against the current schema:

- `Invitation` (new): campaign, email hash, token hash, status, sent_at, opened_at, expires_at; links to Session when bound.
- `Campaign`: verification mode (`invitation`, `email_code`, `open`), domain restriction, link expiry, email hashes for anonymous uniqueness.
- `Session`: path (`technical`, `nontechnical`, null), context block answers, mode preference.
- `Message`: `widget` json and `widgetResponse` json; `audioAttachmentId`.
- `SessionEvent` types gain `finding`, `voice_metrics`, `mode_switch`, `flag`.
- `Setting` (new): scope, scope id, key, value json, version, changed_by; the settings catalog in `packages/shared` defines keys, types, defaults.
- `PromptVersion` (new): key, version, body, scope, canary share, created_by.
- `Provider.kind` gains `stt`, `tts`, `realtime`.
- `Fact` gains `language`; `Attachment` gains `chunks` relation with embeddings.
- `Collaborator` (new, later phase): session, user, role.
