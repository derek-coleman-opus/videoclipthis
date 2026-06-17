/** THE FORK POINT — change these sources to point the bot at your niche. */
export const WATCHLIST = {
  // Resolved to channel IDs at runtime. Handles cost 1 YouTube quota unit to resolve;
  // name search costs 100 — always set the handle when you know it.
  // Mix of orgs (infrequent but high-signal) + interview/podcast channels (frequent, real faces
  // on camera → far better vertical clips than slide talks). Verify handles via /api/debug/youtube.
  youtubeChannels: [
    { name: "Anthropic", handle: "anthropic-ai" },
    { name: "Google DeepMind", handle: "Google_DeepMind" },
    { name: "OpenAI", handle: "OpenAI" },
    { name: "AI Engineer", handle: "aiDotEngineer" },
    { name: "Latent Space", handle: "LatentSpaceTV" },
    { name: "Dwarkesh Patel", handle: "DwarkeshPatel" },
    { name: "No Priors", handle: "NoPriorsPodcast" },
    { name: "Y Combinator", handle: "ycombinator" },
    { name: "a16z", handle: "a16z" },
    { name: "Sequoia Capital", handle: "sequoiacapital" },
    { name: "Machine Learning Street Talk", handle: "MachineLearningStreetTalk" },
    { name: "Lex Fridman", handle: "lexfridman" },
  ] as { name: string; handle?: string }[],
  podcasts: [] as { name: string; rss: string }[],
  xSignalAccounts: ["karpathy", "AnthropicAI", "GoogleDeepMind", "OpenAIDevs"],
  subreddits: ["LocalLLaMA", "MachineLearning"],
};

export const DEFAULT_THRESHOLD = 70;

/** Hardening caps (env-overridable): stop a run after this much spend / this many clips. */
export const COST_CAP_USD = Number(process.env.COST_CAP_USD ?? 5);
export const MAX_CLIPS_PER_RUN = Number(process.env.MAX_CLIPS_PER_RUN ?? 25);

/** Recency window: only ingest videos published within the last N hours. Default 7 days —
 *  watched channels don't post long-form daily, and talks/interviews stay clip-worthy for
 *  weeks, so a tight 48h window starves the pipeline. Lower via MAX_AGE_HOURS for first-to-clip. */
export const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS ?? 168);

/** YouTube search.list costs 100 quota units per call, so figure searches (one per tracked
 *  figure) burn quota fast at a 30-min scout cadence. Only run them every N hours. */
export const FIGURE_SEARCH_INTERVAL_H = Number(process.env.FIGURE_SEARCH_INTERVAL_H ?? 6);

/** OpusClip caps CONCURRENT projects per plan (Pro Beta = 4). Submitting past the cap fails the
 *  create call, so we keep in-flight renders at or below this and queue the rest. Stay a notch
 *  under the plan cap to leave headroom for Summon renders (shared concurrency budget). */
export const MAX_CONCURRENT_RENDERS = Number(process.env.MAX_CONCURRENT_RENDERS ?? 3);
