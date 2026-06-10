/** THE FORK POINT — change these sources to point the bot at your niche. */
export const WATCHLIST = {
  // Resolved to channel IDs at runtime. Handles cost 1 YouTube quota unit to resolve;
  // name search costs 100 — always set the handle when you know it.
  youtubeChannels: [
    { name: "Anthropic", handle: "anthropic-ai" },
    { name: "Google DeepMind", handle: "Google_DeepMind" },
    { name: "OpenAI", handle: "OpenAI" },
    { name: "AI Engineer", handle: "aiDotEngineer" },
  ] as { name: string; handle?: string }[],
  podcasts: [] as { name: string; rss: string }[],
  xSignalAccounts: ["karpathy", "AnthropicAI", "GoogleDeepMind", "OpenAIDevs"],
  subreddits: ["LocalLLaMA", "MachineLearning"],
};

export const DEFAULT_THRESHOLD = 70;

/** Hardening caps (env-overridable): stop a run after this much spend / this many clips. */
export const COST_CAP_USD = Number(process.env.COST_CAP_USD ?? 5);
export const MAX_CLIPS_PER_RUN = Number(process.env.MAX_CLIPS_PER_RUN ?? 25);

/** Recency window: only ingest videos published within the last N hours (first-to-clip). */
export const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS ?? 48);

/** YouTube search.list costs 100 quota units per call, so figure searches (one per tracked
 *  figure) burn quota fast at a 30-min scout cadence. Only run them every N hours. */
export const FIGURE_SEARCH_INTERVAL_H = Number(process.env.FIGURE_SEARCH_INTERVAL_H ?? 6);
