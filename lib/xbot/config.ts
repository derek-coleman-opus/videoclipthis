/** XBot defaults. Pacing values live in xbot_settings so they're tunable without
 *  redeploys; these are the code-side seeds and discovery heuristics. */

export const XBOT_MODEL = "claude-sonnet-4-6";

/** Default recent-search queries for finding build-in-public posters.
 *  Seeded into xbot_settings.keywords on first read; edit from the admin after that. */
export const DEFAULT_KEYWORDS = [
  '"building in public"',
  '"build in public"',
  '"shipped" "MRR"',
  '"day" "of building"',
  '"just launched" "side project"',
];

/** Bio signals that mark an account as a builder/engineer worth targeting. */
export const BIO_BUILDER_KEYWORDS = [
  "build", "building", "shipping", "shipped", "founder", "indie", "maker",
  "engineer", "developer", "dev", "swe", "hacker", "mrr", "saas", "solopreneur",
];

/** Discovery prefilter: ignore accounts below this floor (eggs/brand-new spam). */
export const MIN_FOLLOWERS = 50;

/** Method: keep a roster of 40-50 niche creators you engage with regularly. */
export const TARGET_ROSTER_GOAL = 40;

/** Generic-praise phrases: a reply that is mostly these adds no value and trains
 *  followers (and the algorithm) to ignore the account. */
export const LOW_VALUE_PHRASES = [
  "good post", "great post", "nice post", "great thread", "good thread",
  "well said", "so true", "this is the way", "love this", "love it",
  "best of luck", "good luck", "congrats", "congratulations",
  "awesome", "amazing", "interesting", "totally agree", "thanks for sharing",
  "keep it up", "keep going", "keep shipping", "facts",
];

/** Follower-bait phrasings that get follows who never engage again — banned everywhere. */
export const BANNED_PHRASES = [
  "let's connect", "lets connect", "follow me", "follow back",
  "check out my profile", "dm me", "link in bio",
];

/** Hard ceiling for any single draft (X limit is 280; leave headroom). */
export const MAX_DRAFT_CHARS = 270;

/** X automation-rules pacing: daily caps alone allow bursts (e.g. 20 replies in 10
 *  minutes), which is exactly the pattern X's anti-spam systems look for. Posting is
 *  therefore also held to (a) an hourly cap — the daily cap spread evenly across the
 *  non-quiet window — and (b) a minimum gap between consecutive actions of a kind. */
export const MIN_GAP_MINUTES: Record<string, number> = {
  reply: 5,    // outbound growth replies
  engage: 3,   // engage-backs in our own threads
  post: 30,    // original posts
  like: 2,     // Phase 2 auto-likes
};

/** How many recent posted drafts to compare against for duplicate-text detection. */
export const DUPLICATE_LOOKBACK = 50;

/** Word-overlap (Jaccard) similarity above which two drafts count as duplicates. */
export const DUPLICATE_SIMILARITY = 0.8;

/** Env-overridable pacing for discovery runs (Phase 3). */
export const SEARCH_QUERIES_PER_RUN = Number(process.env.XBOT_SEARCH_QUERIES_PER_RUN ?? 3);
export const SEARCH_MAX_RESULTS = Number(process.env.XBOT_SEARCH_MAX_RESULTS ?? 10);

/** Outbound roster engagement (the "reply guy" loop): how many target timelines to read
 *  per run. Timeline reads are the rate-limited part on X's Basic tier, so this caps the
 *  expensive work; the daily reply cap + pacing still gate what actually gets posted. */
export const OUTBOUND_TARGETS_PER_RUN = Number(process.env.XBOT_OUTBOUND_TARGETS_PER_RUN ?? 8);

/** Only reply to a target's posts this fresh — a reply on a day-old tweet rarely gets seen. */
export const OUTBOUND_TWEET_MAX_AGE_HOURS = Number(process.env.XBOT_OUTBOUND_MAX_AGE_HOURS ?? 24);

/** How many recent tweets to pull per target timeline (X min is 5). */
export const OUTBOUND_TIMELINE_PAGE = Number(process.env.XBOT_OUTBOUND_TIMELINE_PAGE ?? 10);
