import { desc, inArray } from "drizzle-orm";
import { db, xbotDrafts } from "@/lib/db";
import { withRetry } from "@/lib/pipeline/util";
import { MAX_DRAFT_CHARS, XBOT_MODEL } from "./config";

export interface Drafted {
  text: string;
  rationale: string;
  mediaIdea?: string;
}

const REPLY_PROMPT = `You write replies for a real engineer who is building in public on X.
Every reply must EARN its place in the thread by being exactly one of:
- FUNNY: an actually-funny observation about the specific situation (not a joke format),
- CONTRARIAN: a sharp, civil pushback or counter-angle a builder would respect, or
- VALUE-ADDING: a related experience, a concrete suggestion, or a sharp question.
Rules:
- React to the SPECIFIC content of the tweet — name the detail you're responding to.
- Generic praise is FORBIDDEN: never "Good post", "Best of luck", "So true",
  congratulations-only, or any reply that works under every tweet. Those kill accounts.
- 1-2 SHORT sentences, under ${MAX_DRAFT_CHARS} characters. No long paragraphs.
- No hashtags, no emojis, no links, no pitching anything, no "let's connect".
- Sound like a peer builder, not a fan or a marketer.
Return JSON: {"text": "<the reply>", "rationale": "<which lane (funny/contrarian/value) and why, short>"}.`;

const FOLLOWUP_PROMPT = `${REPLY_PROMPT}
This is a FOLLOW-UP: you have replied to this person before (prior interaction included below).
Acknowledge continuity only if it is natural — never "me again!" or anything self-referential.`;

const POST_PROMPT = `You draft standalone X posts for a real engineer building in public.
The account's content is the documented journey toward a public mission — each post is
one beat of that storyline (progress, setback, lesson, or feature shown off in a cool way).
Rules:
- The post MUST open with either a NUMBER (a real metric, count, timespan, or dollar
  amount taken from the author context) or a TAKE (a contrarian or crisply-stated
  opinion a developer would stop scrolling for).
- The first line must work alone in the feed.
- 1-4 SHORT sentences on short lines, under ${MAX_DRAFT_CHARS} characters. No long paragraphs.
- No hashtags, no engagement bait ("agree?", "thoughts?"), no threads.
- Never write follower-bait: no "let's connect", no inspirational one-liners — they attract
  follows that never engage again, which buries every future post.
- Never invent metrics: only use numbers present in the author context.
- Text-only posts underperform badly, so for each variant also suggest "media_idea": one
  concrete image/screenshot/short video the author could attach (dashboard screenshot,
  terminal output, demo clip, face-to-camera). Be specific to the post, not generic.
Return JSON: {"variants": [{"text": "<post>", "rationale": "<short>", "media_idea": "<what to attach>"}, ...]}
with 3 distinct variants (mix number-openers and take-openers when the context allows).`;

const ENGAGE_PROMPT = `You write responses for an engineer building in public on X, replying to
someone who commented on THEIR post (or answered one of their replies). Replying to every
engager is how a small account stays alive: the algorithm shows new posts to followers first,
and engaged followers are the ones who keep showing up.
Rules:
- Continue the conversation, don't close it: react to their specific point, answer any
  question directly, and when natural end with one short question back (about what they're
  building, their experience with the topic — never "thoughts?").
- Warm peer tone; gratitude is fine but never the whole reply.
- 1-2 SHORT sentences, under ${MAX_DRAFT_CHARS} characters.
- No hashtags, no links, no pitching, no "let's connect".
Return JSON: {"text": "<the reply>", "rationale": "<short>"}.`;

const PLUG_PROMPT = `You write the "plug reply" an engineer posts under their OWN tweet once it
gets traction: a casual self-reply that points the new readers at the product, turning the
moment into visitors without souring it.
Rules:
- Reads like a PS to the conversation, not an ad: reference what the original post was about.
- Include the product URL exactly as given, once.
- One or two SHORT sentences plus the link, under ${MAX_DRAFT_CHARS} characters total.
- No hashtags, no "limited time", no exclamation-mark salesmanship, no feature lists.
Return JSON: {"text": "<the reply including the URL>", "rationale": "<short>"}.`;

async function callClaude(system: string, user: string, maxTokens = 500): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const data: any = await withRetry(async () => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: XBOT_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    return res.json();
  }, { label: "anthropic xbot draft" });
  return (data.content ?? []).map((b: any) => b.text ?? "").join("");
}

/** Escape raw control characters (newlines, tabs) that appear INSIDE JSON string values.
 *  Claude routinely emits literal line breaks inside multi-line post text, which strict
 *  JSON.parse rejects ("Expected ',' or '}'..."). We only touch chars inside strings, so
 *  structural whitespace between tokens is left alone. */
function escapeControlCharsInStrings(s: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === "\\") { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString) {
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) { out += "\\u" + code.toString(16).padStart(4, "0"); continue; }
    }
    out += ch;
  }
  return out;
}

/** Parse the JSON object out of an LLM response. Tolerates the most common defect —
 *  unescaped newlines inside string values (multi-line post drafts) — before giving up. */
function parseJson(text: string): any {
  const match = text.match(/\{[\s\S]*\}/);
  const raw = match ? match[0] : text;
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(escapeControlCharsInStrings(raw));
  }
}

function cleanDraft(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("Claude returned an empty draft");
  if (text.length > MAX_DRAFT_CHARS) return text.slice(0, MAX_DRAFT_CHARS).trim();
  return text;
}

/** Recent reply texts, fed back to Claude so it doesn't repeat phrasings. */
async function recentDraftTexts(kinds: string[], limit = 10): Promise<string[]> {
  const rows = await db()
    .select({ text: xbotDrafts.text })
    .from(xbotDrafts)
    .where(inArray(xbotDrafts.kind, kinds))
    .orderBy(desc(xbotDrafts.createdAt))
    .limit(limit);
  return rows.map((r) => r.text);
}

export interface ReplyContext {
  tweetText: string;
  authorHandle: string;
  authorBio?: string;
  voiceNotes?: string;
  mission?: string;      // public storyline (e.g. "0→$1k MRR") — colors the voice
  priorReply?: string;   // set for follow-ups: what we said to them last time
  priorTweet?: string;   // ...and what they had posted then
}

/** Draft one reply (or follow-up) to a specific tweet. */
export async function draftReply(ctx: ReplyContext): Promise<Drafted> {
  const isFollowup = Boolean(ctx.priorReply);
  const avoid = await recentDraftTexts(["reply", "followup"]);
  const user = [
    `Author: @${ctx.authorHandle}`,
    ctx.authorBio ? `Author bio: ${ctx.authorBio}` : "",
    `Their tweet:\n${ctx.tweetText}`,
    ctx.voiceNotes ? `About you (the replier):\n${ctx.voiceNotes}` : "",
    ctx.mission ? `Your public mission/storyline: ${ctx.mission}` : "",
    isFollowup ? `Prior interaction — their tweet then: ${ctx.priorTweet ?? ""}\nYour reply then: ${ctx.priorReply}` : "",
    avoid.length ? `Do not reuse phrasings from your recent replies:\n${avoid.map((t) => `- ${t}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const raw = await callClaude(isFollowup ? FOLLOWUP_PROMPT : REPLY_PROMPT, user);
  const obj = parseJson(raw);
  return { text: cleanDraft(obj.text), rationale: String(obj.rationale ?? "") };
}

/** Draft original-post variants ("open with a number or a take") plus a media idea each. */
export async function draftPostVariants(voiceNotes: string, mission = ""): Promise<Drafted[]> {
  const recentPosts = await recentDraftTexts(["post"]);
  const user = [
    mission ? `Public mission/storyline these posts document: ${mission}` : "",
    `Author context (what you're building, recent milestones, real metrics):\n${voiceNotes || "(none provided — lean on takes, not numbers)"}`,
    recentPosts.length ? `Avoid repeating themes/phrasings from recent posts:\n${recentPosts.map((t) => `- ${t}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const raw = await callClaude(POST_PROMPT, user, 1000);
  const obj = parseJson(raw);
  const variants = Array.isArray(obj.variants) ? obj.variants : [];
  if (!variants.length) throw new Error("Claude returned no post variants");
  return variants.slice(0, 3).map((v: any) => ({
    text: cleanDraft(v.text),
    rationale: String(v.rationale ?? ""),
    mediaIdea: String(v.media_idea ?? ""),
  }));
}

/** Draft the engage-back response to someone who commented on our post / our reply. */
export async function draftEngageBack(opts: {
  theirText: string;
  theirHandle: string;
  ourText?: string;      // what of ours they were responding to, when known
  voiceNotes?: string;
  mission?: string;
}): Promise<Drafted> {
  const avoid = await recentDraftTexts(["engage"]);
  const user = [
    `Commenter: @${opts.theirHandle}`,
    opts.ourText ? `Your post/reply they responded to:\n${opts.ourText}` : "They responded to one of your posts.",
    `Their comment:\n${opts.theirText}`,
    opts.voiceNotes ? `About you:\n${opts.voiceNotes}` : "",
    opts.mission ? `Your public mission/storyline: ${opts.mission}` : "",
    avoid.length ? `Do not reuse phrasings from your recent engage-backs:\n${avoid.map((t) => `- ${t}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const raw = await callClaude(ENGAGE_PROMPT, user);
  const obj = parseJson(raw);
  return { text: cleanDraft(obj.text), rationale: String(obj.rationale ?? "") };
}

/** Draft the traction self-reply that links the product under one of our own posts. */
export async function draftPlugReply(opts: {
  postText: string;
  productUrl: string;
  voiceNotes?: string;
  mission?: string;
}): Promise<Drafted> {
  const user = [
    `Your tweet that is getting traction:\n${opts.postText}`,
    `Product URL to include: ${opts.productUrl}`,
    opts.voiceNotes ? `About you / the product:\n${opts.voiceNotes}` : "",
    opts.mission ? `Your public mission/storyline: ${opts.mission}` : "",
  ].filter(Boolean).join("\n\n");

  const raw = await callClaude(PLUG_PROMPT, user);
  const obj = parseJson(raw);
  const text = cleanDraft(obj.text);
  if (!text.includes(opts.productUrl)) {
    throw new Error("plug draft dropped the product URL — regenerate");
  }
  return { text, rationale: String(obj.rationale ?? "") };
}

const ACCOUNT_SCORE_PROMPT = `You decide whether an X account is worth adding to a builder's
engagement roster — people they'll regularly reply to in order to grow. Score 0-100 on how
good a target this account is, weighting:
- niche fit: is their content in or adjacent to the builder's space (below)?
- real person posting original content: a maker/builder/operator, NOT a brand, news feed,
  reply-spam/growth-hack account, engagement-bait account, or bot.
- conversational: they share their work, ask questions, and reply to people (a reply will
  be seen and can start a relationship), vs. broadcast-only.
- size sweet spot: small enough that a thoughtful reply gets noticed, active enough to matter.
Be strict: most accounts should score below 60. Reserve 70+ for clearly on-niche real builders.
Return JSON: {"score": <int 0-100>, "rationale": "<one short sentence: who they are + why>"}.`;

export interface AccountScore {
  score: number;
  rationale: string;
}

/** Judge whether a discovered account belongs on the engagement roster. Used by the
 *  autonomous discovery loop to gate auto-adding targets. */
export async function scoreAccount(opts: {
  handle: string;
  bio?: string;
  followers?: number;
  following?: number;
  sampleTweets?: string[];
  voiceNotes?: string;
  mission?: string;
}): Promise<AccountScore> {
  const user = [
    `The builder's space (who they want to reach):\n${opts.voiceNotes || opts.mission || "indie builders / software & startups"}`,
    `Candidate account: @${opts.handle}`,
    opts.bio ? `Bio: ${opts.bio}` : "Bio: (none)",
    `Followers: ${opts.followers ?? "unknown"} · Following: ${opts.following ?? "unknown"}`,
    opts.sampleTweets?.length
      ? `Recent posts:\n${opts.sampleTweets.map((t) => `- ${t.replace(/\s+/g, " ").slice(0, 200)}`).join("\n")}`
      : "Recent posts: (none available)",
  ].filter(Boolean).join("\n\n");

  const raw = await callClaude(ACCOUNT_SCORE_PROMPT, user, 200);
  const obj = parseJson(raw);
  const score = Math.round(Number(obj.score));
  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0,
    rationale: String(obj.rationale ?? ""),
  };
}
