-- Deduplication backstop: at most one LIVE (postable) clip per candidate.
--
-- The same video went out four or five times. Three paths caused it, all the same root cause —
-- no atomic claim before a side effect:
--   1. the scout and summon crons are both on */30, so two concurrent drains selected the same
--      `approved` clip and both published it;
--   2. the same two runs could both pick up a `rendering` candidate and each insert a clip row;
--   3. an ambiguous publish failure (X accepted the post, the response was lost) was recorded as
--      `failed`, which offered a one-click retry that posted it again.
--
-- The code fixes those with compare-and-swap claims and a not-posted/ambiguous distinction. This
-- index is the backstop that makes a duplicate live clip impossible regardless.
--
-- Scoped to postable statuses deliberately: `posted` rows are history — including the duplicates
-- this exists to prevent — and a unique constraint over them could not be satisfied without
-- deleting the record of something that really was published.
DELETE FROM "clips" c
  WHERE c."candidate_id" IS NOT NULL
    AND c."status" IN ('pending_review', 'approved', 'posting')
    AND EXISTS (
      SELECT 1 FROM "clips" o
      WHERE o."candidate_id" = c."candidate_id"
        AND o."status" IN ('pending_review', 'approved', 'posting')
        AND o."id" < c."id"
    );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "clips_candidate_live_uniq"
  ON "clips" ("candidate_id")
  WHERE "candidate_id" IS NOT NULL AND "status" IN ('pending_review', 'approved', 'posting');
