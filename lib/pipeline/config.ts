/** THE FORK POINT — change these sources to point the bot at your niche. */
export const WATCHLIST = {
  youtubeChannels: [
    { name: "Anthropic", channelId: "TODO" },
    { name: "Google DeepMind", channelId: "TODO" },
    { name: "OpenAI", channelId: "TODO" },
    { name: "AI Engineer", channelId: "TODO" },
  ],
  podcasts: [] as { name: string; rss: string }[],
  xSignalAccounts: ["karpathy", "AnthropicAI", "GoogleDeepMind", "OpenAIDevs"],
  subreddits: ["LocalLLaMA", "MachineLearning"],
};

/** Channels treated as inherently high-authority by the mock scorer heuristic. */
export const HIGH_AUTHORITY_CHANNELS = new Set([
  "anthropic", "google deepmind", "openai", "ai engineer",
]);

export const DEFAULT_THRESHOLD = 70;

/** Hardening caps (env-overridable): stop a run after this much spend / this many clips. */
export const COST_CAP_USD = Number(process.env.COST_CAP_USD ?? 5);
export const MAX_CLIPS_PER_RUN = Number(process.env.MAX_CLIPS_PER_RUN ?? 25);

/** Mock mode (explicit opt-in only): runs the pipeline on canned demo data, no external APIs.
 *  Default OFF — real mode needs the API keys + go-live wiring (see README "Going live"). */
export function isMock(): boolean {
  return process.env.MOCK_MODE === "1";
}
