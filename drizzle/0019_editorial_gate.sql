-- The editorial gate (lib/pipeline/editorial.ts): judge a finished render before posting it,
-- quote the speaker verbatim in the hook, and keep the source link out of the post body.
-- IF NOT EXISTS added by hand (as in 0018) so a partial failure can be re-run safely.
--
-- candidates.transcript — the editor runs when the render lands, minutes to hours after
-- discovery and in a different process, so the words have to be persisted to be quotable.
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "transcript" text DEFAULT '';--> statement-breakpoint
-- clips.follow_up_text — the in-thread reply carrying the full-talk link.
ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "follow_up_text" text DEFAULT '';--> statement-breakpoint
-- clips.pull_quote — the verbatim line used as the post's first line.
ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "pull_quote" text DEFAULT '';--> statement-breakpoint
-- clips.editorial_score / editorial_note — the editor's shareability verdict. A NULL score means
-- the editor did not run (no API key, or an outage): that must read as "no opinion", never as a
-- rejection, or an Anthropic blip would silently stop the account from posting.
ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "editorial_score" integer;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "editorial_note" text DEFAULT '';
