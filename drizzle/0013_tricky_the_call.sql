CREATE TABLE IF NOT EXISTS "xbot_health" (
	"id" serial PRIMARY KEY NOT NULL,
	"component" text NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text DEFAULT '',
	"consecutive_errors" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "xbot_health_component_idx" ON "xbot_health" USING btree ("component");