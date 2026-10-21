-- What an opportunity rests on, and the facts that support it (D-479).
--
-- Additive only (docs/MIGRATIONS.md): columns with defaults.
--
-- "basis" is 'problem' (participants reported pain, time lost, errors or risk) or 'works_well'
-- (they said it works and should stay as it is: a "no change recommended" item, ranked last).
-- Existing rows are problems. "supportFactIds" are the member facts the item's counts, quotes and
-- evidence come from, a subset of "factIds"; internal like "factIds" and never returned. An empty
-- list (every row written before this) means every member fact.
ALTER TABLE "Opportunity" ADD COLUMN "basis" TEXT NOT NULL DEFAULT 'problem';
ALTER TABLE "Opportunity" ADD COLUMN "supportFactIds" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_basis_check" CHECK ("basis" IN ('problem', 'works_well'));
