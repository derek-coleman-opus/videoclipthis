/** A long-form video detected by a source, before it's persisted/scored. */
export interface DetectedCandidate {
  source: string;
  url: string;
  videoId: string;
  title: string;
  speaker?: string;
  speakerHandle?: string;   // resolved X handle (no @); empty => held (credit-first rule)
  channel?: string;
  event?: string;
  durationS?: number;
  publishedAt?: Date | null;
  signalStrength?: number;
  transcript?: string;
  figureName?: string;   // set when a tracked key AI figure is matched (figures.ts)
}

/** A specific viral-worthy segment chosen from the source. OpusClip renders clips during the
 *  project, so the chosen moment already carries its rendered clip URL + cost. */
export interface Moment {
  startS: number;
  endS: number;
  hookCaption: string;
  confidence: number;
  clipUrl: string;  // rendered 9:16 captioned clip from OpusClip
  costUsd: number;  // per-clip cost if reported, else 0
}
