-- Migration 0018 — render-spend guards, in the single-statement form the Neon SQL console needs.
-- Paste the whole block as one statement. Idempotent: safe to re-run after a partial failure.
--
-- What it does:
--   1. candidates.submit_attempts — bounds retries of the BILLED OpusClip create call.
--   2. Collapses duplicate video_ids (rows with no clips only) so step 3 can succeed.
--   3. candidates_video_id_uniq — hard backstop against paying for the same video twice.
--
-- If step 3 raises a unique-violation, two candidate rows for one video BOTH have clips: a real
-- double-charge. Find them with the query at the bottom and delete the losing row by hand.
DO $$
BEGIN
  ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "submit_attempts" integer NOT NULL DEFAULT 0;

  DELETE FROM "candidates" c
  WHERE c."source" <> 'summon'
    AND NOT EXISTS (SELECT 1 FROM "clips" cl WHERE cl."candidate_id" = c."id")
    AND EXISTS (
      SELECT 1 FROM "candidates" o
      WHERE o."source" <> 'summon'
        AND o."video_id" = c."video_id"
        AND o."id" <> c."id"
        AND (EXISTS (SELECT 1 FROM "clips" cl2 WHERE cl2."candidate_id" = o."id") OR o."id" < c."id")
    );

  CREATE UNIQUE INDEX IF NOT EXISTS "candidates_video_id_uniq"
    ON "candidates" ("video_id") WHERE "source" <> 'summon';
END $$;

-- Audit query — duplicate paid renders that survived (run separately):
--   SELECT video_id, count(*) AS rows, array_agg(id) AS candidate_ids,
--          array_agg(opus_project_id) AS opus_projects
--   FROM candidates WHERE source <> 'summon' AND opus_project_id IS NOT NULL
--   GROUP BY video_id HAVING count(*) > 1 ORDER BY count(*) DESC;
