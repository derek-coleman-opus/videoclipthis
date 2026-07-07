import { desc, inArray } from "drizzle-orm";
import { db, xbotDrafts } from "@/lib/db";
import { withRetry } from "@/lib/pipeline/util";
import { MAX_DRAFT_CHARS, XBOT_MODEL } from "./config";

export interface Drafted {
  text: string;
  rationale: string;
  mediaIdea?: string;
}

/** Reviewer-selectable voice for a draft. "auto" lets the model pick the best lane. */
export type DraftStyle = "auto" | "funny" | "informative" | "contrarian";

/** Extra instruction appended when the reviewer regenerates a draft in a specific style. */
function styleDirective(style?: DraftStyle): string {
  switch (style) {
    case "funny":
      return "CHOSEN STYLE: funny — a witty, specific observation about their exact situation; land the joke, never corny or a generic one-liner.";
    case "informative":
      return "CHOSEN STYLE: informative — lead with one concrete, genuinely useful insight, tip, or sharp specific question that helps them.";
    case "contrarian":
      return "CHOSEN STYLE: contrarian — a civil but sharp counter-take or pushback a builder would respect.";
    default:
      return "";
  }
}

const HUMAN_VOICE = `You are a real builder typing a quick reply on X from your phone. You are NOT an AI,
NOT a brand, NOT writing an essay. The goal: indistinguishable from a human. Most replies that
read as "AI" do so for these exact reasons — avoid every one:

HARD BANS (any of these = it reads as AI, rewrite it):
- em dashes or en dashes ( — – ). Never. Use a comma, a period, or two short sentences.
- the shapes: "isn't just X, it's Y", "the ___ arc", "X, which is either ... or ... depending on ...",
  "not only ... but also", perfectly balanced three-part lists, semicolons.
- the words: "relatable", "extremely", "deeply", "genuinely", "incredible", "game-changer",
  "love this", "underrated", "the dream", "wild", "fascinating", "speaks to".
- restating their tweet back to them, or explaining your own joke.
- corporate/fan/marketer tone, hype adjectives, motivational closers.

DO:
- keep it SHORT. usually one line, often under ~100 characters. fragments are good. if it looks
  like a finished sentence from a blog post, cut it in half.
- lowercase is fine and usually better. contractions always. casual, even a little blunt or dry.
- react to ONE specific detail like you actually read it, or ask one real question.
- mild slang only if it fits naturally and sparingly (lol, ngl, tbh, fwiw, kinda). never forced.

GOOD vs BAD (note: short, lowercase, specific, zero em dashes):
BAD:  "Congrats on the milestone! Shipping 412 clips truly shows incredible dedication — inspiring stuff."
GOOD: "412 clips solo is unhinged output. what's breaking first, you or the infra"
BAD:  "This is such a relatable take — building in public is genuinely a game-changer for founders."
GOOD: "is build in public actually moving numbers for you or just feels good? curious"
BAD:  "Your agents kept shipping while you were down — which is either the dream or mildly unsettling."
GOOD: "bots kept shipping while you were sick lol. thats kind of the whole pitch"`;

const REPLY_PROMPT = `${HUMAN_VOICE}

You're replying to someone's tweet. Earn the reply by ADDING SOMETHING they'd actually want to
read. Default lane: genuinely useful — a real tip from experience, a concrete answer to a
question they raised, or a specific, non-obvious question that moves their thinking. Funny or
contrarian is fine ONLY when you have a real angle; never reach for a quip.
Rules that keep it from reading badly:
- Say something only someone who READ and UNDERSTOOD the tweet could say. Reference the specific
  thing, not the topic in general.
- No forced edginess, no trying-to-be-the-funny-guy, no "hot take" for its own sake. Dry and
  understated beats loud. If you don't have a real point, a sharp genuine question is better.
- Never generic praise ("good post", "so true", congrats-only) — invisible and screams bot.
- It should read like a knowledgeable peer, not a try-hard. When unsure, be useful, not clever.
Return JSON: {"text": "<the reply>", "rationale": "<lane (useful/funny/contrarian) + why, short>"}.`;

const FOLLOWUP_PROMPT = `${REPLY_PROMPT}
FOLLOW-UP: you've replied to this person before (prior interaction below). Pick up naturally,
like you remember them. Never say "me again" or anything self-referential.`;

const POST_PROMPT = `${HUMAN_VOICE}

Now write standalone X POSTS (not replies) for this builder — one beat of their public build-in-public
journey (progress, a setback, a lesson, or a feature shown off).
Post specifics on top of the voice rules above:
- open with a real NUMBER from the author context, or a blunt TAKE. first line has to land alone.
- 1-4 short lines. line breaks instead of long sentences. still no em dashes, still casual.
- no hashtags, no "agree?"/"thoughts?" bait, no threads, no inspirational closers.
- never invent metrics — only numbers actually in the author context.
- for each variant also give "media_idea": one concrete thing to attach (screenshot, terminal,
  short demo clip, face-to-camera). specific to the post. text-only posts die.
Return JSON: {"variants": [{"text": "<post>", "rationale": "<short>", "media_idea": "<what to attach>"}, ...]}
with 3 distinct variants (mix number-openers and take-openers).`;

const ENGAGE_PROMPT = `${HUMAN_VOICE}

Someone replied to YOUR post (or answered your reply). Reply back like a real person keeping a
conversation going: react to their actual point, answer anything they asked, and if it's natural
end with one genuine question. warm but not gushing. thanking them is fine but never the whole reply.
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

/** Mechanical backstop for the most recognizable AI tells the prompt already bans, in case
 *  the model slips. The em dash is the big one — convert "a — b" into "a, b". */
function humanize(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ") // em/en dash → comma
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/^[,\s]+/, "")
    .trim();
}

function cleanDraft(raw: unknown): string {
  const text = humanize(String(raw ?? "").trim());
  if (!text) throw new Error("Claude returned an empty draft");
  if (text.length > MAX_DRAFT_CHARS) return humanize(text.slice(0, MAX_DRAFT_CHARS));
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
  style?: DraftStyle;    // reviewer-chosen voice when regenerating
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
    styleDirective(ctx.style),
    avoid.length ? `Do not reuse phrasings from your recent replies:\n${avoid.map((t) => `- ${t}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const raw = await callClaude(isFollowup ? FOLLOWUP_PROMPT : REPLY_PROMPT, user);
  const obj = parseJson(raw);
  return { text: cleanDraft(obj.text), rationale: String(obj.rationale ?? "") };
}

/** Draft original-post variants ("open with a number or a take") plus a media idea each. */
export async function draftPostVariants(voiceNotes: string, mission = "", style?: DraftStyle): Promise<Drafted[]> {
  const recentPosts = await recentDraftTexts(["post"]);
  const user = [
    mission ? `Public mission/storyline these posts document: ${mission}` : "",
    `Author context (what you're building, recent milestones, real metrics):\n${voiceNotes || "(none provided — lean on takes, not numbers)"}`,
    styleDirective(style),
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
  style?: DraftStyle;
}): Promise<Drafted> {
  const avoid = await recentDraftTexts(["engage"]);
  const user = [
    `Commenter: @${opts.theirHandle}`,
    opts.ourText ? `Your post/reply they responded to:\n${opts.ourText}` : "They responded to one of your posts.",
    `Their comment:\n${opts.theirText}`,
    opts.voiceNotes ? `About you:\n${opts.voiceNotes}` : "",
    opts.mission ? `Your public mission/storyline: ${opts.mission}` : "",
    styleDirective(opts.style),
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
- niche fit: is their content in or adjacent to the builder's space (below)? Adjacent counts.
- real person posting original content: a maker/builder/operator/creator, NOT a brand,
  news feed, reply-spam/growth-hack account, engagement-bait account, or bot.
- conversational: they share their work, ask questions, and reply to people (a reply will
  be seen and can start a relationship), vs. broadcast-only.
Scoring guide (be selective, not harsh — we want a healthy roster, not perfection):
- 60-100: a real person whose content is on- or adjacent-to niche and who could plausibly
  engage back. Most genuine builders/creators in the space belong here.
- 40-59: real person but only loosely related, or thin/unclear signal.
- 0-39: brand/company, news/aggregator, bot, engagement-bait/growth-hack, or clearly off-niche.
When the signal is genuine-builder-in-the-space, lean toward including them.
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
