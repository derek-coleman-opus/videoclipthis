CREATE TABLE IF NOT EXISTS "figures" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"x_handle" text NOT NULL,
	"org" text DEFAULT '',
	"role" text DEFAULT '',
	"priority" integer DEFAULT 2,
	"youtube_channel_id" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "figures_handle_idx" ON "figures" USING btree ("x_handle");