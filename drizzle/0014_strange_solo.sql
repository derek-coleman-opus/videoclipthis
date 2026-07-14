ALTER TABLE "xbot_settings" ADD COLUMN "lock_detected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "xbot_settings" ADD COLUMN "lock_reason" text DEFAULT '';