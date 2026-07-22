CREATE TABLE IF NOT EXISTS "resolved_handles" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"handle" text DEFAULT '' NOT NULL,
	"confidence" real DEFAULT 0,
	"evidence" text DEFAULT '',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resolved_handles_name_kind_idx" ON "resolved_handles" USING btree ("name","kind");