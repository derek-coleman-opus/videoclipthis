import {
  pgTable, serial, integer, real, text, boolean, timestamp, index, uniqueIndex,
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
  opusProjectId: text("opus_project_id"),            // OpusClip project rendering this candidate's clips
  renderStartedAt: ts("render_started_at"),          // when the render was SUBMITTED (timeout clock)
  status: text("status").notNull().default("found"), // found|scored|held|skipped|rendering|selected|posted|failed
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
  status: text("status").notNull().default("pending_review"),
      // pending_review | approved (ready, waiting for a paced posting slot) | posted | rejected | failed
  failReason: text("fail_reason").default(""),         // why the last publish attempt failed (retriable)
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
  autonomy: text("autonomy").notNull().default("review"), // review|auto (legacy "assisted" treated as review)
  dailyClipCap: integer("daily_clip_cap").notNull().default(6), // max auto-posted scout clips per UTC day
  niche: text("niche").notNull().default("AI / developer tooling"), // audience the scorer ranks for
  watchChannels: text("watch_channels").notNull().default(""), // "Name | handle" per line; "" → code WATCHLIST
  opusBrandTemplateId: text("opus_brand_template_id"), // OpusClip template: vertical layout + caption style
  searchTopics: text("search_topics").notNull().default(""), // topic/keyword search terms, one per line; "" → code defaults
  searchOffset: integer("search_offset").notNull().default(0), // rotation cursor into the figure+topic search list
  summonSinceId: text("summon_since_id"),                 // last @mention id processed (Summon poll cursor)
  xBotUserId: text("x_bot_user_id"),                      // cached id of the bot's own X account
  figureSearchAt: ts("figure_search_at"),                 // last figure-search run (quota throttle)
  updatedAt: ts("updated_at").defaultNow(),
});

/** Tracked AI figures — editable from the admin; seeded from code defaults on first use. */
export const figures = pgTable("figures", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  xHandle: text("x_handle").notNull(),
  org: text("org").default(""),
  role: text("role").default(""),
  priority: integer("priority").default(2),
  youtubeChannelId: text("youtube_channel_id"),
  createdAt: ts("created_at").defaultNow(),
}, (t) => ({
  handleIdx: uniqueIndex("figures_handle_idx").on(t.xHandle),
}));

/* ───────────────────────────── XBot (personal-account growth bot) ─────────────────────────────
   Separate from the clip bot above: these tables drive the engagement pipeline for the
   admin's personal building-in-public X account (likes auto, replies/posts reviewed). */

/** Accounts the XBot engages with — discovered via search/seeds or added manually. */
export const xbotTargets = pgTable("xbot_targets", {
  id: serial("id").primaryKey(),
  xUserId: text("x_user_id"),                          // null until hydrated from the X API
  handle: text("handle").notNull(),                    // no @
  displayName: text("display_name").default(""),
  bio: text("bio").default(""),
  followers: integer("followers").default(0),
  following: integer("following").default(0),
  engagementRate: real("engagement_rate").default(0),  // avg(likes+replies)/followers, sampled
  score: integer("score"),                             // Claude account-quality 0-100
  rationale: text("rationale").default(""),
  source: text("source").notNull().default("manual"),  // search | seed | manual
  seedHandle: text("seed_handle"),                     // which seed surfaced them
  status: text("status").notNull().default("candidate"), // candidate|active|cooldown|engaged_back|archived|blocked
  repliesSent: integer("replies_sent").default(0),
  engagedBack: boolean("engaged_back").default(false), // they liked/replied to one of our replies
  lastRepliedAt: ts("last_replied_at"),
  lastCheckedAt: ts("last_checked_at"),                // re-engage poll cursor
  createdAt: ts("created_at").defaultNow(),
}, (t) => ({
  handleIdx: uniqueIndex("xbot_targets_handle_idx").on(t.handle),
  statusIdx: index("xbot_targets_status_idx").on(t.status),
}));

/** Seed accounts whose repliers/engagers get mined as target candidates. */
export const xbotSeeds = pgTable("xbot_seeds", {
  id: serial("id").primaryKey(),
  handle: text("handle").notNull(),
  xUserId: text("x_user_id"),
  active: boolean("active").notNull().default(true),
  lastMinedAt: ts("last_mined_at"),                    // mining throttle
  createdAt: ts("created_at").defaultNow(),
}, (t) => ({
  handleIdx: uniqueIndex("xbot_seeds_handle_idx").on(t.handle),
}));

/** Discovered tweets by targets — the like/reply candidate pool. */
export const xbotTweets = pgTable("xbot_tweets", {
  id: serial("id").primaryKey(),
  tweetId: text("tweet_id").notNull(),                 // dedupes across runs
  targetId: integer("target_id").references(() => xbotTargets.id),
  authorHandle: text("author_handle").notNull(),
  text: text("text").notNull(),                        // snapshot for drafting context
  likeCount: integer("like_count").default(0),
  replyCount: integer("reply_count").default(0),
  viewCount: integer("view_count").default(0),
  tweetedAt: ts("tweeted_at"),
  foundVia: text("found_via").notNull().default("search"), // search | seed | reengage | manual | inbound
  liked: boolean("liked").default(false),
  likedAt: ts("liked_at"),
  status: text("status").notNull().default("found"),   // found | drafted | skipped | stale
  createdAt: ts("created_at").defaultNow(),
}, (t) => ({
  tweetIdIdx: uniqueIndex("xbot_tweets_tweet_id_idx").on(t.tweetId),
  statusIdx: index("xbot_tweets_status_idx").on(t.status),
}));

/** The review queue: Claude-drafted replies, follow-ups, original posts, plug replies,
 *  and engage-backs (responses to people who commented on our posts). */
export const xbotDrafts = pgTable("xbot_drafts", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),                        // reply | followup | post | plug | engage
  targetId: integer("target_id").references(() => xbotTargets.id),
  tweetRefId: integer("tweet_ref_id").references(() => xbotTweets.id),
  inReplyToTweetId: text("in_reply_to_tweet_id"),      // null for original posts
  contextText: text("context_text").default(""),       // target tweet snapshot for the review UI
  text: text("text").notNull(),
  status: text("status").notNull().default("pending_review"),
      // pending_review | held | approved | scheduled | posted | rejected | failed
  scheduledAt: ts("scheduled_at"),
  xPostId: text("x_post_id"),
  postedAt: ts("posted_at"),
  editedByHuman: boolean("edited_by_human").default(false),
  rationale: text("rationale").default(""),            // why Claude chose this angle
  holdReason: text("hold_reason").default(""),         // why the safety gate held an auto-post
  mediaIdea: text("media_idea").default(""),           // suggested image/video — text-only posts underperform
  createdAt: ts("created_at").defaultNow(),
}, (t) => ({
  statusIdx: index("xbot_drafts_status_idx").on(t.status),
}));

/** Append-only action ledger — the authoritative source for daily caps and rate budgets. */
export const xbotActions = pgTable("xbot_actions", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),                        // like|reply|post|search|read_user|mine_seed
  targetId: integer("target_id"),
  tweetId: text("tweet_id"),
  createdAt: ts("created_at").defaultNow(),
}, (t) => ({
  kindCreatedIdx: index("xbot_actions_kind_created_idx").on(t.kind, t.createdAt),
}));

/** Single-row XBot runtime config (id is always 1). Starts paused. */
export const xbotSettings = pgTable("xbot_settings", {
  id: integer("id").primaryKey().default(1),
  paused: boolean("paused").notNull().default(true),
  replyAutonomy: text("reply_autonomy").notNull().default("review"), // review | auto
  postAutonomy: text("post_autonomy").notNull().default("review"),   // review | auto
  likesAuto: boolean("likes_auto").notNull().default(true),
  dailyReplyCap: integer("daily_reply_cap").notNull().default(20),   // method: 15-30/day
  dailyLikeCap: integer("daily_like_cap").notNull().default(40),
  dailyPostCap: integer("daily_post_cap").notNull().default(3),      // method: 3-5/day
  dailyEngageCap: integer("daily_engage_cap").notNull().default(50), // engage-backs: reply to EVERYONE who comments
  cooldownDays: integer("cooldown_days").notNull().default(3),       // min days between replies to same target
  quietStartUtc: integer("quiet_start_utc").notNull().default(22),   // engage 14:00-22:00 UTC ≈ 9am-5pm EST
  quietEndUtc: integer("quiet_end_utc").notNull().default(14),
  maxFollowers: integer("max_followers").notNull().default(5000),    // method: target creators <5000 followers
  keywords: text("keywords").notNull().default("[]"),                // JSON array; seeded from lib/xbot/config.ts
  searchSinceId: text("search_since_id"),                            // recent-search cursor
  mentionsSinceId: text("mentions_since_id"),                        // inbound-engagement (mentions) cursor
  xbotUserId: text("xbot_user_id"),                                  // cached own X user id
  voiceNotes: text("voice_notes").default(""),                       // user's voice/context injected into prompts
  mission: text("mission").default(""),                              // public storyline, e.g. "0→$1k MRR"
  productUrl: text("product_url").default(""),                       // linked in plug replies under traction posts
  communityId: text("community_id").default(""),                     // X community to post into (small-account reach)
  setupChecklist: text("setup_checklist").notNull().default("[]"),   // JSON array of completed playbook item ids
  lockDetectedAt: ts("lock_detected_at"),                            // when an X account lock last tripped the circuit breaker
  lockReason: text("lock_reason").default(""),                       // the X error that tripped it
  updatedAt: ts("updated_at").defaultNow(),
});

/** Per-component XBot health: one row per worker, upserted every run — the "why did it stop"
 *  ledger the dashboard reads. A component whose lastErrorAt > lastOkAt is currently failing. */
export const xbotHealth = pgTable("xbot_health", {
  id: serial("id").primaryKey(),
  component: text("component").notNull(),              // outbound|harvest|likes|posting|inbound|discover
  lastRunAt: ts("last_run_at"),
  lastOkAt: ts("last_ok_at"),
  lastErrorAt: ts("last_error_at"),
  lastError: text("last_error").default(""),
  consecutiveErrors: integer("consecutive_errors").notNull().default(0),
}, (t) => ({
  componentIdx: uniqueIndex("xbot_health_component_idx").on(t.component),
}));

export type Candidate = typeof candidates.$inferSelect;
export type NewCandidate = typeof candidates.$inferInsert;
export type Clip = typeof clips.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type FigureRow = typeof figures.$inferSelect;
export type XbotTarget = typeof xbotTargets.$inferSelect;
export type NewXbotTarget = typeof xbotTargets.$inferInsert;
export type XbotSeed = typeof xbotSeeds.$inferSelect;
export type XbotTweet = typeof xbotTweets.$inferSelect;
export type XbotDraft = typeof xbotDrafts.$inferSelect;
export type NewXbotDraft = typeof xbotDrafts.$inferInsert;
export type XbotAction = typeof xbotActions.$inferSelect;
export type XbotSettings = typeof xbotSettings.$inferSelect;
export type XbotHealth = typeof xbotHealth.$inferSelect;
