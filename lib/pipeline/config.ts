/** THE FORK POINT — change these sources to point the bot at your niche. */
export const WATCHLIST = {
  // Resolved to channel IDs at runtime (by handle if given, else by name search).
  youtubeChannels: [
    { name: "Anthropic" },
    { name: "Google DeepMind" },
    { name: "OpenAI" },
    { name: "AI Engineer" },
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
