import { desc, inArray } from "drizzle-orm";
import { db, xbotDrafts } from "@/lib/db";
import { withRetry } from "@/lib/pipeline/util";
import { MAX_DRAFT_CHARS, XBOT_MODEL } from "./config";

export interface Drafted {
  text: string;
  rationale: string;
}

const REPLY_PROMPT = `You write replies for a real engineer who is building in public on X.
Rules:
- React to the SPECIFIC content of the tweet — name the detail you're responding to.
- Add exactly one of: a related experience, a concrete suggestion, a sharp question,
  or a genuine specific compliment about the work (never about the person generically).
- 1-2 sentences, under ${MAX_DRAFT_CHARS} characters.
- No hashtags, no emojis, no links, no "Great post!", no pitching anything.
- Sound like a peer builder, not a fan or a marketer.
Return JSON: {"text": "<the reply>", "rationale": "<why this angle, short>"}.`;

const FOLLOWUP_PROMPT = `${REPLY_PROMPT}
This is a FOLLOW-UP: you have replied to this person before (prior interaction included below).
Acknowledge continuity only if it is natural — never "me again!" or anything self-referential.`;

const POST_PROMPT = `You draft standalone X posts for a real engineer building in public.
Rules:
- The post MUST open with either a NUMBER (a real metric, count, timespan, or dollar
  amount taken from the author context) or a TAKE (a contrarian or crisply-stated
  opinion a developer would stop scrolling for).
- The first line must work alone in the feed.
- 1-4 short lines total, under ${MAX_DRAFT_CHARS} characters.
- No hashtags, no engagement bait ("agree?", "thoughts?"), no threads.
- Never invent metrics: only use numbers present in the author context.
Return JSON: {"variants": [{"text": "<post>", "rationale": "<short>"}, ...]} with 3 distinct variants
(mix number-openers and take-openers when the context allows).`;

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

function parseJson(text: string): any {
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
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
    isFollowup ? `Prior interaction — their tweet then: ${ctx.priorTweet ?? ""}\nYour reply then: ${ctx.priorReply}` : "",
    avoid.length ? `Do not reuse phrasings from your recent replies:\n${avoid.map((t) => `- ${t}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const raw = await callClaude(isFollowup ? FOLLOWUP_PROMPT : REPLY_PROMPT, user);
  const obj = parseJson(raw);
  return { text: cleanDraft(obj.text), rationale: String(obj.rationale ?? "") };
}

/** Draft original-post variants ("open with a number or a take"). */
export async function draftPostVariants(voiceNotes: string): Promise<Drafted[]> {
  const recentPosts = await recentDraftTexts(["post"]);
  const user = [
    `Author context (what you're building, recent milestones, real metrics):\n${voiceNotes || "(none provided — lean on takes, not numbers)"}`,
    recentPosts.length ? `Avoid repeating themes/phrasings from recent posts:\n${recentPosts.map((t) => `- ${t}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const raw = await callClaude(POST_PROMPT, user, 800);
  const obj = parseJson(raw);
  const variants = Array.isArray(obj.variants) ? obj.variants : [];
  if (!variants.length) throw new Error("Claude returned no post variants");
  return variants.slice(0, 3).map((v: any) => ({
    text: cleanDraft(v.text),
    rationale: String(v.rationale ?? ""),
  }));
}
