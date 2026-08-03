import type { DetectedCandidate, Moment } from "./types";
import type { EditorialVerdict } from "./editorial";

/** Short enough to sit under the hook without eating the frame. The old footer spent 66
 *  characters — above the fold, on a format where line one decides everything — on telling
 *  people it was a bot and advertising the stack. Both belong in the profile, not every post. */
export const FOOTER = "🤖 clipped by an agent";

/** The credit-first "gift, not competition" model in code (build plan §1): the speaker is the
 *  hero — tagged, credited, and linked to. What changed is the ORDER.
 *
 *  The old template opened with the account's own feelings ("Loved @X's talk 🙌 Clipped my
 *  favorite 47s for you — <clip title>") and closed with the source URL. Three problems, all
 *  fixed here: nobody quote-tweets a stranger's enthusiasm, the clip TITLE is descriptive where
 *  the claim is arresting, and a link in the body suppresses reach — so the full talk now goes
 *  out as an in-thread follow-up (see followUpText) instead.
 *
 *  Now: the speaker's own words first, attribution second. */
export function composePost(
  c: DetectedCandidate,
  m: Moment,
  ed?: EditorialVerdict | null,
): string {
  const credit = creditLine(c, m);
  const tail = `\n\n${credit}\n\n${FOOTER}`;
  const raw = ed?.pullQuote
    // No usable verbatim quote — fall back to the clip caption, but still lead with the substance.
    ? ed.pullQuote
    : m.hookCaption || "the moment worth watching";
  // A 200-char quote plus a long event name can clear 280, and X rejects the whole post — so
  // the hook yields, never the credit. Quotes are cut at a word boundary.
  const hook = ed?.pullQuote
    ? `“${fitToBudget(raw, X_MAX_WEIGHT - xWeight(tail) - xWeight("“”"))}”`
    : fitToBudget(raw, X_MAX_WEIGHT - xWeight(tail));
  return `${hook}${tail}`;
}

/** X's post limit, in its own weighted characters. */
export const X_MAX_WEIGHT = 280;

/** X's weighted character count: Latin text, punctuation and common dashes/quotes count 1;
 *  emoji and CJK count 2. Implemented from X's published ranges so a post that measures 280
 *  here is a post X accepts — a length rejection wastes a paid render on a retry loop. */
export function xWeight(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    const light =
      (cp >= 0 && cp <= 4351) ||
      (cp >= 8192 && cp <= 8205) ||
      (cp >= 8208 && cp <= 8223) ||
      (cp >= 8242 && cp <= 8247);
    n += light ? 1 : 2;
  }
  return n;
}

/** Trim text to a weighted budget at a word boundary, marking the cut with an ellipsis. */
export function fitToBudget(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (xWeight(text) <= budget) return text;
  const ellipsis = "…";
  const room = budget - xWeight(ellipsis);
  if (room <= 0) return "";
  let out = "";
  for (const ch of text) {
    if (xWeight(out + ch) > room) break;
    out += ch;
  }
  const lastSpace = out.lastIndexOf(" ");
  if (lastSpace > room * 0.6) out = out.slice(0, lastSpace);
  return `${out.replace(/[\s,;:.!?—-]+$/, "")}${ellipsis}`;
}

/** Attribution, in one of a few shapes so a scroll down the timeline doesn't read as one
 *  sentence repeated forever. The variant is chosen from the content itself (not at random) so a
 *  given clip always composes to the same text — retries and manual re-approvals can't produce a
 *  different post for the same clip. */
export function creditLine(c: DetectedCandidate, m: Moment): string {
  const who = c.speakerHandle ? `@${c.speakerHandle}` : c.speaker || "this speaker";
  const brand = c.channelXHandle && c.channelXHandle.toLowerCase() !== (c.speakerHandle ?? "").toLowerCase()
    ? `@${c.channelXHandle}`
    : c.channel || "";
  const len = Math.round(m.endS - m.startS);
  const where = c.event ? ` at ${c.event}` : brand ? ` on ${brand}` : "";

  const variants = [
    `— ${who}${where}`,
    `${who}${where}, ${len}s`,
    `That's ${who}${where}.`,
    `${who}${where} 👆`,
  ];
  return variants[hashIndex(`${c.videoId}:${m.hookCaption}`, variants.length)];
}

/** Stable small hash → variant index. Deterministic per clip, spread across the set. */
function hashIndex(seed: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % Math.max(1, mod);
}

/** The in-thread follow-up carrying the source link. Keeping the URL out of the post body is
 *  the reach fix; posting it as the first reply keeps the credit-first promise intact — the full
 *  talk is still one tap away, and the speaker still gets the click. "" = nothing to follow up. */
export function followUpText(c: DetectedCandidate): string {
  if (!c.url) return "";
  const brand = c.channelXHandle && c.channelXHandle.toLowerCase() !== (c.speakerHandle ?? "").toLowerCase()
    ? ` via @${c.channelXHandle}`
    : "";
  return `Full talk${brand}: ${c.url}`;
}

/** Summon replies post IN-THREAD as a comment under the requester's tag — so no "full talk"
 *  link (it's the same thread), and the credit goes to the VIDEO'S author, never the person
 *  who summoned the bot. Same quote-first treatment as a scout post. */
export function composeSummonReply(
  c: DetectedCandidate,
  m: Moment,
  ed?: EditorialVerdict | null,
): string {
  const who = c.speakerHandle ? `@${c.speakerHandle}` : c.speaker || "";
  const len = Math.round(m.endS - m.startS);
  if (ed?.pullQuote) {
    const head = `🎬 The best ${len}s:\n\n`;
    const tail = `${who ? ` — ${who}` : ""}\n\n${FOOTER}`;
    const room = X_MAX_WEIGHT - xWeight(head) - xWeight(tail) - xWeight("“”");
    return `${head}“${fitToBudget(ed.pullQuote, room)}”${tail}`;
  }
  const credit = who ? ` of ${who}'s video` : "";
  const prefix = `🎬 Here's the best ${len}s${credit} — `;
  const suffix = `\n\n${FOOTER}`;
  return `${prefix}${fitToBudget(m.hookCaption, X_MAX_WEIGHT - xWeight(prefix) - xWeight(suffix))}${suffix}`;
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
  /** Optional in-thread follow-up (the source link). Best-effort — see xPublisher. */
  followUpText?: string;
}
