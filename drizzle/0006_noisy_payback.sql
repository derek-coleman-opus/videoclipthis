ALTER TABLE "xbot_settings" ADD COLUMN "daily_engage_cap" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "xbot_settings" ADD COLUMN "mentions_since_id" text;