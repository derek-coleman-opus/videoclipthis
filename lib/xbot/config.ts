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

/** How many recent posted drafts to compare against for duplicate-text detection. */
export const DUPLICATE_LOOKBACK = 50;

/** Word-overlap (Jaccard) similarity above which two drafts count as duplicates. */
export const DUPLICATE_SIMILARITY = 0.8;

/** Env-overridable pacing for discovery runs (Phase 3). */
export const SEARCH_QUERIES_PER_RUN = Number(process.env.XBOT_SEARCH_QUERIES_PER_RUN ?? 3);
export const SEARCH_MAX_RESULTS = Number(process.env.XBOT_SEARCH_MAX_RESULTS ?? 10);
