-- DRILL ONLY: a migration that fails half way through, to rehearse docs/OPERATIONS.md#migratefailed.
-- migration-policy: allow-destructive drill
CREATE TABLE "DrillPartial" (id int);
SELECT 1/0;
