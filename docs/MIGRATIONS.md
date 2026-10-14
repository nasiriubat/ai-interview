# Migrations

The policy for changing the schema of a database that holds people's answers and runs on one
box. Decision D-178; the gate is `scripts/check-migrations.mjs`, run by `pnpm check`.

## The policy

**Forward-fix, not down scripts.** Prisma writes no down migrations, a hand-written one is rarely
exercised, and a single self-hosted Postgres recovers by restore. So there is no `down`: a bad
migration is fixed by a new one, and a bad release is undone by the previous image tag.

**Additive only.** A release may add:

- a nullable column, or a column with a `DEFAULT`;
- a table;
- an index;
- a constraint that existing rows already satisfy.

Removing or reshaping something ships one release after the code stopped reading the old shape
(expand, then contract). That is what makes the previous code run against the newer schema, which
is what makes rolling back a tag switch.

**What the gate refuses** in a migration newer than 0017:

| Statement                                     | Why                                                     |
| --------------------------------------------- | ------------------------------------------------------- |
| `DROP COLUMN`, `DROP TABLE`                   | The previous release still reads it                     |
| `RENAME COLUMN`, `RENAME TO`                  | A rename is a drop for code that still uses the name    |
| `ALTER COLUMN ... TYPE`                       | Rewrites the table and can fail on data                 |
| `ALTER COLUMN ... SET NOT NULL`               | Existing rows or the previous release may hold `NULL`   |
| `ADD COLUMN ... NOT NULL` without a `DEFAULT` | Fails on any existing row; the old code cannot write it |

Two migrations may not share a number either: branches that each took the next number would run in
an order nobody chose. The second to merge takes the next one.

## Doing the destructive thing anyway

Sometimes the old shape really must go (a column that held plaintext it should never have held).
Annotate the migration, anywhere in the file, with the reason and the recovery:

```sql
-- migration-policy: allow-destructive provider headers moved to headersEnc in 0017; recovery is the pre-migration dump
ALTER TABLE "Provider" DROP COLUMN "headers";
```

The annotation covers the whole file, needs a reason, and is the sign that **that release needs
the dump to roll back**. The gate prints it as a note so the release notes can say so.

## Rolling back

1. Every migration since the tag you are going back to is additive: switch the tag
   (`deploy/rollback.sh`). The older code runs against the newer schema; the extra columns and
   tables are ignored.
2. Some migration since then is annotated `allow-destructive`: restore the pre-migration dump
   (`docs/OPERATIONS.md`, "Why most upgrades need no data rollback") and switch the tag.

`deploy/upgrade.sh` takes a backup through the running backup container before it migrates and
refuses to go on without one (`--skip-backup` needs `--yes`); the dump it names is the data-side
rollback.

## Writing one

1. Add the column as nullable, or with a default. Write the backfill in the same migration (the
   owner role bypasses row-level security, so it can read every tenant).
2. The code that reads it must tolerate `NULL` for as long as the previous release can still run.
3. Put the destructive half in the next release's migration, after the code stopped reading it.
4. Run `node scripts/check-migrations.mjs`; `pnpm check` runs it with its own tests.

## What this does not do

It does not detect a migration file edited after it was applied: Prisma's own checksum refuses
that on the database that ran it, and review is what catches it before then.
