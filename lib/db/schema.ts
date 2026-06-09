import {
  pgTable, serial, integer, real, text, boolean, timestamp, index,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });

/** Every long-form video the Scout/Summon detected, with its scoring + status. */
export const candidates = pgTable("candidates", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),                 // youtube | podcast | x | hn | reddit | summon
  url: text("url").notNull(),
  videoId: text("video_id").notNull(),
  title: text("title").notNull(),
  speaker: text("speaker").default(""),
  speakerHandle: text("speaker_handle").default(""), // resolved X handle (no @); "" => held
  channel: text("channel").default(""),
  event: text("event").default(""),
  durationS: integer("duration_s").default(0),
  publishedAt: ts("published_at"),
  detectedAt: ts("detected_at").defaultNow(),        // starts the first-to-clip clock
  signalStrength: real("signal_strength").default(0),
  figureName: text("figure_name"),                   // matched tracked AI figure, if any
  status: text("status").notNull().default("found"), // found|scored|held|skipped|selected|posted|failed
  score: integer("score"),
  rationale: text("rationale").default(""),
  createdAt: ts("created_at").defaultNow(),
}, (t) => ({
  videoIdIdx: index("candidates_video_id_idx").on(t.videoId),
  statusIdx: index("candidates_status_idx").on(t.status),
}));

/** A produced clip (credit-first post) — scout posts and summon replies. */
export const clips = pgTable("clips", {
  id: serial("id").primaryKey(),
  candidateId: integer("candidate_id").references(() => candidates.id),
  startS: real("start_s").default(0),
  endS: real("end_s").default(0),
  hookCaption: text("hook_caption").default(""),
  postText: text("post_text").notNull(),
  clipUrl: text("clip_url").default(""),
  xPostId: text("x_post_id"),
  replyTo: text("reply_to"),                          // tweet id for summon replies
  kind: text("kind").notNull().default("scout"),      // scout | summon
  status: text("status").notNull().default("pending_review"), // pending_review|approved|posted|rejected|failed
  views: integer("views").default(0),
  resharedBySpeaker: boolean("reshared_by_speaker").default(false),
  costUsd: real("cost_usd").default(0),
  createdAt: ts("created_at").defaultNow(),
  postedAt: ts("posted_at"),
}, (t) => ({
  statusIdx: index("clips_status_idx").on(t.status),
}));

/** Inbound @videoclipthis mentions (Summon mode). */
export const summonRequests = pgTable("summon_requests", {
  id: serial("id").primaryKey(),
  tweetId: text("tweet_id").notNull(),
  requester: text("requester").default(""),
  targetUrl: text("target_url").default(""),
  status: text("status").notNull().default("received"), // received|resolved|clipped|replied|failed
  candidateId: integer("candidate_id").references(() => candidates.id),
  createdAt: ts("created_at").defaultNow(),
});

/** One row per pipeline run (cron or manual). */
export const runs = pgTable("runs", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull().default("scout"),
  mock: boolean("mock").default(false),
  startedAt: ts("started_at").defaultNow(),
  finishedAt: ts("finished_at"),
  found: integer("found").default(0),
  posted: integer("posted").default(0),
  skipped: integer("skipped").default(0),
  errors: text("errors").default(""),
});

/** Chronological activity feed shown on the dashboard. */
export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),                       // found|scored|held|skipped|posted|replied|error|run
  message: text("message").notNull(),
  refTable: text("ref_table"),
  refId: integer("ref_id"),
  createdAt: ts("created_at").defaultNow(),
}, (t) => ({
  createdIdx: index("events_created_idx").on(t.createdAt),
}));

/** Single-row runtime config the admin can edit (id is always 1). */
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  paused: boolean("paused").notNull().default(false),
  threshold: integer("threshold").notNull().default(70),
  autonomy: text("autonomy").notNull().default("review"), // review|assisted|auto
  updatedAt: ts("updated_at").defaultNow(),
});

export type Candidate = typeof candidates.$inferSelect;
export type NewCandidate = typeof candidates.$inferInsert;
export type Clip = typeof clips.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type Settings = typeof settings.$inferSelect;
