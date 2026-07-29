CREATE TABLE IF NOT EXISTS "x_writes" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"tweet_id" text,
	"reply_to" text,
	"detail" text DEFAULT '',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "x_writes_created_idx" ON "x_writes" USING btree ("created_at");