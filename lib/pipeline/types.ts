/** A long-form video detected by a source, before it's persisted/scored. */
export interface DetectedCandidate {
  source: string;
  url: string;
  videoId: string;
  title: string;
  speaker?: string;
  speakerHandle?: string;   // resolved X handle (no @) of the human speaker
  channel?: string;
  channelXHandle?: string;  // the channel/brand's X handle (no @) — operator-verified, never guessed
  event?: string;
  durationS?: number;
  publishedAt?: Date | null;
  signalStrength?: number;
  /** Observed traction, straight from YouTube. The whole point of a virality strategy is to catch
   *  a video while it is taking off, and nothing else in this pipeline can see that: the scorer
   *  judges shareability from the title and transcript alone, which is a guess about how a video
   *  MIGHT travel, not evidence that it IS travelling. */
  viewCount?: number;
  /** Views per hour since publication. The signal that finds an unknown account going viral —
   *  a 6-hour-old video at 40k views is exploding; the same 40k over three weeks is not. */
  viewsPerHour?: number;
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
