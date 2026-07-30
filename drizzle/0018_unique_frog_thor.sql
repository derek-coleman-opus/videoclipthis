ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "submit_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Existing duplicate video_ids would make the unique index below fail, so collapse them first.
-- Only rows with NO clips are removed (clips.candidate_id is a FK, and a clip is evidence the row
-- produced real output). Survivors per video: every clip-bearing row, or — if none has a clip —
-- the oldest row. If two rows for one video BOTH have clips, the index creation below fails loudly
-- with the conflicting video_id; that is a genuine double-charge to reconcile by hand.
DELETE FROM "candidates" c
WHERE c."source" <> 'summon'
  AND NOT EXISTS (SELECT 1 FROM "clips" cl WHERE cl."candidate_id" = c."id")
  AND EXISTS (
    SELECT 1 FROM "candidates" o
    WHERE o."source" <> 'summon'
      AND o."video_id" = c."video_id"
      AND o."id" <> c."id"
      AND (EXISTS (SELECT 1 FROM "clips" cl2 WHERE cl2."candidate_id" = o."id") OR o."id" < c."id")
  );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "candidates_video_id_uniq" ON "candidates" USING btree ("video_id") WHERE "candidates"."source" <> 'summon';
