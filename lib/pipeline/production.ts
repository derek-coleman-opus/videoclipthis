import type { DetectedCandidate, Moment } from "./types";

export const FOOTER = "🤖 found, clipped & posted by an agent · built on OpusClip · fork it";

/** The credit-first "gift, not competition" model in code (build plan §1).
 *  The speaker is the hero: tag + credit them, link the full talk, label it agent-made. */
export function composePost(c: DetectedCandidate, m: Moment): string {
  const who = c.speakerHandle ? `@${c.speakerHandle}` : c.speaker || "this speaker";
  const event = c.event ? ` at ${c.event}` : "";
  const len = Math.round(m.endS - m.startS);
  const line =
    `Loved ${who}'s talk${event} 🙌 Clipped my favorite ${len}s for you — ` +
    `${m.hookCaption} 👇 (full talk: ${c.url})`;
  return `${line}\n\n${FOOTER}`;
}

/** Credit-first rule: hold a clip we can't confidently attribute. */
export function needsCreditResolution(c: DetectedCandidate): boolean {
  return !(c.speakerHandle || c.speaker);
}

export interface ProducedClip {
  clipUrl: string;
  postText: string;
  costUsd: number;
  durationS: number; // clip length, so the publisher can pick the right X media category
}

export interface Clipper {
  produce(c: DetectedCandidate, m: Moment): Promise<ProducedClip>;
}

/** The clip is already rendered by OpusClip during selection — here we just compose the
 *  credit-first post text around it. (Args kept for symmetry / future direct-render needs.) */
export function opusclipClipper(_apiKey: string, _base: string): Clipper {
  return {
    async produce(c, m) {
      return {
        clipUrl: m.clipUrl,
        postText: composePost(c, m),
        costUsd: m.costUsd,
        durationS: Math.max(0, Math.round(m.endS - m.startS)),
      };
    },
  };
}
