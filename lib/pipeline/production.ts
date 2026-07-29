import type { DetectedCandidate, Moment } from "./types";

export const FOOTER = "🤖 found, clipped & posted by an agent · built on OpusClip · fork it";

/** X counts every URL as 23 chars (t.co); approximate the real post length accordingly. */
function xLength(text: string): number {
  return text.replace(/https?:\/\/\S+/g, "x".repeat(23)).length;
}

/** The credit-first "gift, not competition" model in code (build plan §1).
 *  The speaker is the hero: tag + credit them, link the full talk, label it agent-made.
 *  The brand/channel gets tagged too ("via @…"), plus up to 2 verified entity tags (orgs
 *  central to the clip) — tags are what earn the engagement, capped at 3 total so posts
 *  never read as tag-spam, and length-guarded against X's 280. */
export function composePost(c: DetectedCandidate, m: Moment): string {
  const who = c.speakerHandle ? `@${c.speakerHandle}` : c.speaker || "this speaker";
  const brandX = c.channelXHandle && c.channelXHandle.toLowerCase() !== (c.speakerHandle ?? "").toLowerCase()
    ? c.channelXHandle : "";
  const event = c.event ? ` at ${c.event}` : "";
  const len = Math.round(m.endS - m.startS);
  const line =
    `Loved ${who}'s talk${event} 🙌 Clipped my favorite ${len}s for you — ` +
    `${m.hookCaption} 👇 (full talk: ${c.url}${brandX ? ` via @${brandX}` : ""})`;

  // cc verified entity tags, up to 3 tags total per post; drop rather than overflow 280.
  const used = new Set([c.speakerHandle, brandX].filter(Boolean).map((h) => (h as string).toLowerCase()));
  let cc = "";
  for (const tag of c.extraTags ?? []) {
    if (used.size >= 3) break;
    if (used.has(tag.toLowerCase())) continue;
    const next = `${cc} @${tag}`;
    if (xLength(`${line}${next ? ` cc${next}` : ""}\n\n${FOOTER}`) > 278) break;
    cc = next;
    used.add(tag.toLowerCase());
  }
  return `${line}${cc ? ` cc${cc}` : ""}\n\n${FOOTER}`;
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

/** Tags are best-effort (auto-resolved + verified when possible) and never hold a clip up —
 *  a text-name credit is an acceptable fallback. Only a clip with NO attribution at all
 *  (no handle, no speaker name, no channel name) is held for the operator. */
export function needsCreditResolution(c: DetectedCandidate): boolean {
  return !(c.speakerHandle || c.channelXHandle || c.speaker || c.channel);
}

export interface ProducedClip {
  clipUrl: string;
  postText: string;
  costUsd: number;
  durationS: number; // clip length, so the publisher can pick the right X media category
}

