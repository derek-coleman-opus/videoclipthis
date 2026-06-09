import { opusclipClips } from "./opusclip";
import type { DetectedCandidate, Moment } from "./types";

export interface Selector {
  select(c: DetectedCandidate): Promise<Moment | null>;
}

export function opusclipSelector(opusKey: string, _anthropicKey: string): Selector {
  return {
    async select(c) {
      const base = process.env.OPUSCLIP_API_BASE ?? "https://api.opus.pro";
      // OpusClip renders the project's top clips during analysis; take the highest-virality one.
      // TODO-LIVE: optionally have Claude curate among the top clips + rewrite the hook (§3.4).
      const clips = await opusclipClips(c.url, opusKey, base);
      if (!clips.length) return null;
      const best = clips[0]; // opusclipClips returns clips sorted by score, best first
      return {
        startS: best.startS,
        endS: best.endS,
        hookCaption: best.caption || "the moment worth watching",
        confidence: Math.min(1, best.score / 100),
        clipUrl: best.clipUrl,
        costUsd: best.costUsd,
      };
    },
  };
}
