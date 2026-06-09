import type { DetectedCandidate } from "./types";

export interface Figure {
  name: string;
  xHandle: string;            // without the @
  youtubeChannelId?: string;  // used by the YouTube source (M-next) to watch their channel
  org?: string;
  role?: string;
  priority?: number;          // 1 (highest) .. 3
}

/**
 * Key AI figures we track — they share talks/videos worth clipping. THE FORK POINT for *people*
 * (the org-channel fork point is config.ts WATCHLIST). Tracking a figure means:
 *  - we can always resolve their @ to credit + tag them (the credit-first growth loop), and
 *  - their content auto-ranks higher (authority boost in scoring).
 */
export const FIGURES: Figure[] = [
  { name: "Andrej Karpathy", xHandle: "karpathy", org: "ex-OpenAI/Tesla", role: "researcher", priority: 1 },
  { name: "Demis Hassabis", xHandle: "demishassabis", org: "Google DeepMind", role: "CEO", priority: 1 },
  { name: "Sam Altman", xHandle: "sama", org: "OpenAI", role: "CEO", priority: 1 },
  { name: "Dario Amodei", xHandle: "DarioAmodei", org: "Anthropic", role: "CEO", priority: 1 },
  { name: "Jeff Dean", xHandle: "JeffDean", org: "Google", role: "researcher", priority: 1 },
  { name: "Yann LeCun", xHandle: "ylecun", org: "Meta", role: "researcher", priority: 2 },
  { name: "Andrew Ng", xHandle: "AndrewYNg", org: "DeepLearning.AI", role: "educator", priority: 2 },
  { name: "Simon Willison", xHandle: "simonw", org: "indie", role: "builder", priority: 2 },
  { name: "Swyx", xHandle: "swyx", org: "Latent Space", role: "builder", priority: 2 },
];

/** Match a detected candidate to a tracked figure (from the given list) by handle,
 *  or by the figure's name appearing in the title/speaker/channel. */
export function matchFigure(figures: Figure[], c: DetectedCandidate): Figure | null {
  const handle = (c.speakerHandle ?? "").toLowerCase();
  if (handle) {
    const byHandle = figures.find((f) => f.xHandle.toLowerCase() === handle);
    if (byHandle) return byHandle;
  }
  const hay = `${c.title} ${c.speaker ?? ""} ${c.channel ?? ""}`.toLowerCase();
  for (const f of figures) {
    if (hay.includes(f.name.toLowerCase())) return f;
  }
  return null;
}
