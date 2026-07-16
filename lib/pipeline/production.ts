import type { DetectedCandidate, Moment } from "./types";

export const FOOTER = "🤖 found, clipped & posted by an agent · built on OpusClip · fork it";

/** The credit-first "gift, not competition" model in code (build plan §1).
 *  The speaker is the hero: tag + credit them, link the full talk, label it agent-made.
 *  The brand/channel gets tagged too ("via @…") — every post tags someone. */
export function composePost(c: DetectedCandidate, m: Moment): string {
  const who = c.speakerHandle ? `@${c.speakerHandle}` : c.speaker || "this speaker";
  const brandX = c.channelXHandle && c.channelXHandle.toLowerCase() !== (c.speakerHandle ?? "").toLowerCase()
    ? c.channelXHandle : "";
  const event = c.event ? ` at ${c.event}` : "";
  const len = Math.round(m.endS - m.startS);
  const line =
    `Loved ${who}'s talk${event} 🙌 Clipped my favorite ${len}s for you — ` +
    `${m.hookCaption} 👇 (full talk: ${c.url}${brandX ? ` via @${brandX}` : ""})`;
  return `${line}\n\n${FOOTER}`;
}

/** Summon replies post IN-THREAD as a comment under the requester's tag — so no "full talk"
 *  link (it's the same thread), and the credit goes to the VIDEO'S author, never the person
 *  who summoned the bot. */
export function composeSummonReply(c: DetectedCandidate, m: Moment): string {
  const who = c.speakerHandle ? `@${c.speakerHandle}` : c.speaker || "";
  const len = Math.round(m.endS - m.startS);
  const credit = who ? ` of ${who}'s video` : "";
  return `🎬 Here's the best ${len}s${credit} — ${m.hookCaption}\n\n${FOOTER}`;
}

/** Every post must TAG someone — the speaker's @ or the channel/brand's @. A clip with
 *  neither (name-only or fully unattributed) is held for the operator. */
export function needsCreditResolution(c: DetectedCandidate): boolean {
  return !(c.speakerHandle || c.channelXHandle);
}

export interface ProducedClip {
  clipUrl: string;
  postText: string;
  costUsd: number;
  durationS: number; // clip length, so the publisher can pick the right X media category
}

