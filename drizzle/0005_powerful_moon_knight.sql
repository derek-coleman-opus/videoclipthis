ALTER TABLE "xbot_settings" ALTER COLUMN "daily_post_cap" SET DEFAULT 3;--> statement-breakpoint
ALTER TABLE "xbot_settings" ALTER COLUMN "quiet_start_utc" SET DEFAULT 22;--> statement-breakpoint
ALTER TABLE "xbot_settings" ALTER COLUMN "quiet_end_utc" SET DEFAULT 14;--> statement-breakpoint
ALTER TABLE "xbot_drafts" ADD COLUMN "media_idea" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "xbot_settings" ADD COLUMN "mission" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "xbot_settings" ADD COLUMN "product_url" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "xbot_settings" ADD COLUMN "community_id" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "xbot_settings" ADD COLUMN "setup_checklist" text DEFAULT '[]' NOT NULL;