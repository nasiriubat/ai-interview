# Evals

Fixed transcripts and checks that run in CI on every change (NFR-06). Two kinds:

- **Deterministic** (`*.eval.ts`, run by `pnpm test`): replay a scripted interview through the
  real engine with a scripted model and assert coverage progression, focus order, widget
  policy, and shortening behavior. No network, no keys. These guard the engine's logic.
- **Model-backed** (`pnpm eval:live`, phase 5): run the same fixtures against configured
  providers and score fact recall after summary, issue detection precision, and spec
  completeness with a rubric. Costs real tokens; runs on demand and nightly, not per commit.

Fixtures live in `fixtures/`. Each fixture is a participant script: the answers a
participant gives, in order, plus the expected coverage milestones.
