# 14 API surface

Fastify, JSON over HTTPS, WebSocket for live turns and voice. All routes tenant-scoped
by the authenticated principal or the signed session token. Generated client for the web.

| Module | Routes (summary) |
|---|---|
| identity | sign-in (magic link, Google), me, users CRUD, roles |
| templates | list, get, create, update (new version), publish, archive, diff shipped, preview session |
| campaigns | CRUD, invitations (create, send, remind, revoke), share link settings, progress, close, analyze now |
| participant | open link, verify email code, consent, delete my data, my summary |
| sessions | create, get, turns (POST answer; stream response), state, events, pause, resume, complete, attachments (upload, status), mode |
| voice | WebSocket: audio in, captions and audio out, barge-in; recorded upload and transcription status |
| analysis | runs (list, start, status, diff), clusters (merge, split, rename), opportunities (list, override, dismiss, shortlist, promote), report (get, sections, export) |
| requirements | projects list, spec (get live, edit section), findings (list, resolve, accept, defer), versions, exports (download, pdf, github push), collaborators |
| providers | CRUD, models (fetch), prices (list, set), routes (get, set), test |
| budgets | CRUD, spend queries by dimension |
| settings | catalog, get, set by scope, history |
| prompts | list, versions, set canary, rollback |
| audit | query |
| operator | tenants CRUD, flags, global stats |
| health | liveness, readiness, job queue stats |
