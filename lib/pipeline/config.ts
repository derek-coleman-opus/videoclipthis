/** THE FORK POINT — change these sources to point the bot at your niche. */
export const WATCHLIST = {
  // Resolved to channel IDs at runtime. Handles cost 1 YouTube quota unit to resolve;
  // name search costs 100 — always set the handle when you know it.
  // Mix of orgs (infrequent but high-signal) + interview/podcast channels (frequent, real faces
  // on camera → far better vertical clips than slide talks). Verify handles via /api/debug/youtube.
  youtubeChannels: [
    { name: "Anthropic", handle: "anthropic-ai", xHandle: "AnthropicAI" },
    { name: "Google DeepMind", handle: "Google_DeepMind", xHandle: "GoogleDeepMind" },
    { name: "OpenAI", handle: "OpenAI", xHandle: "OpenAI" },
    { name: "AI Engineer", handle: "aiDotEngineer", xHandle: "aiDotEngineer" },
    { name: "Latent Space", handle: "LatentSpaceTV", xHandle: "latentspacepod" },
    { name: "Dwarkesh Patel", handle: "DwarkeshPatel", xHandle: "dwarkesh_sp" },
    { name: "No Priors", handle: "NoPriorsPodcast", xHandle: "NoPriorsPod" },
    { name: "Y Combinator", handle: "ycombinator", xHandle: "ycombinator" },
    { name: "a16z", handle: "a16z", xHandle: "a16z" },
    { name: "Sequoia Capital", handle: "sequoiacapital", xHandle: "sequoia" },
    { name: "Machine Learning Street Talk", handle: "MachineLearningStreetTalk", xHandle: "MLStreetTalk" },
    { name: "Lex Fridman", handle: "lexfridman", xHandle: "lexfridman" },
  ] as { name: string; handle?: string; xHandle?: string }[],
  podcasts: [] as { name: string; rss: string }[],
  xSignalAccounts: ["karpathy", "AnthropicAI", "GoogleDeepMind", "OpenAIDevs"],
  subreddits: ["LocalLLaMA", "MachineLearning"],
};

export const DEFAULT_THRESHOLD = 70;

/** Hardening caps (env-overridable), ENFORCED in runScout before render submission:
 *  stop submitting once today's recorded clip spend reaches the cap, and never submit
 *  more than MAX_CLIPS_PER_RUN renders in a single run. */
export const COST_CAP_USD = Number(process.env.COST_CAP_USD ?? 5);
export const MAX_CLIPS_PER_RUN = Number(process.env.MAX_CLIPS_PER_RUN ?? 25);

/** Auto-post pacing: minimum minutes between consecutive clip posts (scout kind). The daily
 *  volume cap itself lives in settings.dailyClipCap so it's tunable from the admin. */
export const MIN_CLIP_POST_GAP_MIN = Number(process.env.MIN_CLIP_POST_GAP_MIN ?? 20);

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

/** Topic/keyword YouTube searches — a discovery vector beyond the channel list and tracked
 *  figures. Admin "Search topics" overrides these. Each search.list call costs 100 quota units. */
export const SEARCH_TOPICS = [
  "AI agents", "LLM agents", "coding agents", "frontier models", "open source LLM",
  "AI coding", "model context protocol", "AI evals", "reinforcement learning from human feedback",
  "long context models", "multimodal AI", "AI interview", "GPU inference", "vibe coding",
  "prompt engineering", "RAG retrieval augmented generation",
];

/** Cap on figure+topic search.list calls PER search burst, rotated across runs so the full list
 *  is covered over a day without blowing the daily YouTube quota. ~budget × 100 units per burst. */
export const SEARCH_BUDGET_PER_BURST = Number(process.env.SEARCH_BUDGET_PER_BURST ?? 12);
