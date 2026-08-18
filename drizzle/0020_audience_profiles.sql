-- Audience profiles (lib/pipeline/audience.ts): one switch that moves the scorer, the curator, the
-- editor AND discovery to a different reader at once. Before this, three of those prompts read a
-- `niche` string while still hard-coding "working developer" in their bodies, and the curator —
-- the prompt that decides which 30 seconds get posted — ignored the niche entirely.
--
-- IF NOT EXISTS added by hand (as in 0018/0019) so a partial failure can be re-run safely.
--
-- The defaults reproduce the previous AI/developer behavior exactly: applying this migration
-- changes no behavior until a profile is selected in the admin.
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "active_profile" text NOT NULL DEFAULT 'ai-developer';--> statement-breakpoint
-- Per-profile snapshot of the edited fields (niche, topics, channels, threshold, curation brief),
-- so switching lanes and back never loses hand-tuned config. JSON keyed by profile key.
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "profile_overrides" text NOT NULL DEFAULT '{}';--> statement-breakpoint
-- Operator override for the moment-selection prompt. Blank means "use the active profile's brief".
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "curation_brief" text NOT NULL DEFAULT '';
