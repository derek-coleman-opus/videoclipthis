# CLAUDE.md

Guidance for Claude Code when working in this repository.

## SQL handed to the user for console execution

When giving the user SQL to paste into a hosted SQL console (Neon SQL editor,
Vercel Postgres, etc.), it MUST be a single statement. These consoles often send
the input as one prepared statement, and Postgres rejects multi-command prepared
statements with: `cannot insert multiple commands into a prepared statement`.

Wrap multi-step DDL/DML in one `DO $$ BEGIN … END $$;` block:

- Plain DDL (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
  `ALTER TABLE`, `UPDATE`) works directly inside PL/pgSQL.
- For statements without an `IF NOT EXISTS` form (e.g. `ADD CONSTRAINT`), use a
  nested `BEGIN … EXCEPTION WHEN duplicate_object THEN NULL; END;` sub-block.
- Keep scripts idempotent — the user may re-run after a partial failure.

The canonical example is `scripts/xbot-schema-bootstrap.sql`.

## Database migrations

- Schema lives in `lib/db/schema.ts` (Drizzle); generate migrations with
  `npm run db:generate`, apply with `npm run db:push` (needs `DATABASE_URL`).
- The user typically has no local checkout: migrations get applied through the
  Neon console, so also provide the single-statement SQL form described above.
- Keep migrations additive; never rewrite or reorder existing files in `drizzle/`.
- **Every schema change MUST be added to ALL THREE of these**, not just the first:
  1. `app/api/admin/migrate/route.ts` — the one-click idempotent sync the
     operator runs from the browser. Without it the column never gets created.
  2. `REQUIRED_COLUMNS` in `app/api/admin/diagnostics/route.ts` — the drift
     check. Without it diagnostics reports a **clean schema while the app is
     down**, which is worse than no check at all.
  3. `scripts/xbot-schema-bootstrap.sql` — xbot tables only.

  A migration that exists only in `drizzle/` WILL ship code that crashes
  production with `column "..." does not exist`. This has now happened **twice**
  (0019, then 0020 — where the second one missed only the diagnostics list, so
  the outage reported itself as healthy). Three hand-maintained copies of the
  same schema is the real defect here; deriving `REQUIRED_COLUMNS` from
  `schema.ts` would retire this rule instead of restating it.
- **`settings` columns are the dangerous ones.** `getSettings()` selects that row
  by explicit column list and every entry point calls it — both crons, every
  admin page, `/api/run`. A missing `settings` column is not a degraded
  pipeline, it is a dead deployment, and it throws before `runScout` inserts its
  `runs` row, so nothing is written anywhere. The signature is **no new `runs`
  rows after a deploy**.
