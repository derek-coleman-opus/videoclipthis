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
- **Every schema change MUST also be added to `app/api/admin/migrate/route.ts`**
  (the one-click idempotent sync the operator runs from the browser) and, for
  xbot tables, to `scripts/xbot-schema-bootstrap.sql`. A migration that exists
  only in `drizzle/` WILL ship code that crashes production with
  `column "..." does not exist` — this has happened; don't repeat it.
