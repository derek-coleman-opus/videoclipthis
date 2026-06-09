import { opusclipAnalyze } from "./opusclip";
import type { DetectedCandidate, Moment } from "./types";

export interface Selector {
  select(c: DetectedCandidate): Promise<Moment | null>;
}

export function opusclipSelector(opusKey: string, _anthropicKey: string): Selector {
  return {
    async select(c) {
      const base = process.env.OPUSCLIP_API_BASE ?? "https://api.opus.pro";
      const segs = await opusclipAnalyze(c.url, opusKey, base);
      if (!segs.length) return null;
      // Pick the highest virality-scored segment.
      // TODO-LIVE: optionally have Claude curate among the top segments + rewrite the hook (§3.4).
      const best = segs.reduce((a, b) => (b.score > a.score ? b : a));
      return {
        startS: best.startS,
        endS: best.endS,
        hookCaption: best.caption || "the moment worth watching",
        confidence: Math.min(1, best.score / 100),
      };
    },
  };
}
