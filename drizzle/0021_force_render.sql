-- Operator force-render override: push a candidate the scorer skipped through the render and post
-- gates by hand. A human picking a specific video out of /found is a direct request, and "it scored
-- below the threshold" is not an acceptable answer to one — the same reasoning as the summon
-- exemption already in render.ts.
--
-- IF NOT EXISTS added by hand (as in 0018-0020) so a partial failure can be re-run safely.
-- Additive with a false default, so applying this changes no behavior until the button is used.
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "forced" boolean NOT NULL DEFAULT false;
