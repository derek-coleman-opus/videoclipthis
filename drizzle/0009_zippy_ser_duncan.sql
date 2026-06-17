ALTER TABLE "settings" ADD COLUMN "search_topics" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "search_offset" integer DEFAULT 0 NOT NULL;