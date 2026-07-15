// Content-safety gates for the clip pipeline. Summon is an open door — ANY X user can tag
// @videoclipthis under any tweet with a URL — so everything that flows in through it gets
// screened BEFORE we spend a render on it, and every unattended post (summon replies +
// autonomy=auto scout posts) gets a final text screen before it goes out. Manual approvals
// skip the post-screen: a human already judged them.
//
// Fail-safe: any error or uncertainty → NOT safe. A missed reply costs a little goodwill;
// the bot replying under (or with) adult content costs the account.

import { withRetry, slog } from "./util";

/** Video hosts summon will clip from. YouTube/Vimeo moderate uploads (no adult content),
 *  which makes the allowlist itself the strongest single filter. Direct video-file links,
 *  adult sites, and X-hosted media are all refused. */
const ALLOWED_SUMMON_HOSTS = [
  "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
  "vimeo.com", "www.vimeo.com",
];

export interface SafetyVerdict {
  allow: boolean;
  reason: string;
}

/** Hard gate: is this URL on a host summon is willing to clip from? */
export function allowedSummonUrl(url: string): SafetyVerdict {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (ALLOWED_SUMMON_HOSTS.includes(host)) return { allow: true, reason: "" };
    return { allow: false, reason: `unsupported video host "${host}" — summon only clips YouTube/Vimeo` };
  } catch {
    return { allow: false, reason: "not a valid URL" };
  }
}

/** High-precision keyword prefilter for obviously unsafe requests/titles. Kept tight so it
 *  never blocks normal dev/AI talks; the Claude pass handles nuance. */
const NSFW_RE = /\b(porn|pornhub|xxx|nsfw|onlyfans|nudes?|sex\s*(tape|video|cam)|xvideos|hentai|escort)\b/i;

function claudeKey(): string {
  return process.env.ANTHROPIC_API_KEY ?? "";
}

const SAFETY_MODEL = process.env.CLIP_SAFETY_MODEL ?? "claude-sonnet-4-6";

async function claudeVerdict(system: string, user: string): Promise<SafetyVerdict> {
  const data: any = await withRetry(async () => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": claudeKey(),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: SAFETY_MODEL,
        max_tokens: 150,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    return res.json();
  }, { label: "anthropic clip safety" });
  const text: string = (data.content ?? []).map((b: any) => b.text ?? "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  const obj = JSON.parse(m ? m[0] : text);
  return obj?.safe === true
    ? { allow: true, reason: "" }
    : { allow: false, reason: String(obj?.reason ?? "flagged by safety check") };
}

const TARGET_SCREEN_PROMPT = `You are a content-safety gate for an automated video-clipping bot on X.
A user has asked the bot to clip a video. Decide if the request is safe to fulfil.
It is NOT safe if the video or the request suggests: adult/sexual content of any kind, graphic
violence or gore, hate or harassment, self-harm, shock content, illegal activity, or an attempt
to use the bot for a pile-on or to mock a private person. Normal talks, podcasts, demos, panels,
interviews, tutorials, and entertainment are safe. When unsure, answer not safe.
Return JSON: {"safe": true|false, "reason": "<short>"}.`;

/** Fetch the video's public title/author via YouTube oEmbed (no API quota). Best-effort. */
async function fetchOEmbedTitle(url: string): Promise<{ title: string; author: string } | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const j: any = await res.json();
    return { title: String(j.title ?? ""), author: String(j.author_name ?? "") };
  } catch {
    return null;
  }
}

/** Screen a summon request BEFORE submitting the render: host allowlist → keyword prefilter →
 *  Claude judgment on the video title + requester's tweet. Fail-safe: errors → not allowed. */
export async function screenSummonTarget(
  url: string,
  requesterText: string,
): Promise<SafetyVerdict> {
  const hostCheck = allowedSummonUrl(url);
  if (!hostCheck.allow) return hostCheck;

  const meta = url.includes("vimeo") ? null : await fetchOEmbedTitle(url);
  const combined = `${requesterText} ${meta?.title ?? ""} ${meta?.author ?? ""}`;
  if (NSFW_RE.test(combined)) {
    return { allow: false, reason: "request/title matches adult-content filter" };
  }

  try {
    return await claudeVerdict(
      TARGET_SCREEN_PROMPT,
      [
        `Video URL: ${url}`,
        meta?.title ? `Video title: ${meta.title}` : "",
        meta?.author ? `Channel: ${meta.author}` : "",
        requesterText ? `The user's tweet asking for the clip: ${requesterText}` : "",
      ].filter(Boolean).join("\n"),
    );
  } catch (e) {
    slog("clip_safety_error", { url, error: (e as Error).message });
    return { allow: false, reason: "safety check unavailable — request held" };
  }
}

const POST_SCREEN_PROMPT = `You are a brand-safety gate for a video clip that an automated bot is
about to post publicly on X with NO human review. Judge from the clip's title/caption and post text.
It is NOT safe if it contains or clearly relates to: adult/sexual content, graphic violence, hate or
harassment, self-harm, shock content, or anything that would read as the bot mocking or piling onto
someone. Normal tech talks, demos, interviews, and insights are safe. When unsure, answer not safe.
Return JSON: {"safe": true|false, "reason": "<short>"}.`;

/** Final screen before an UNATTENDED post (summon auto-reply or autonomy=auto scout post).
 *  Judges the clip's own text signals. Fail-safe: errors → hold for human review. */
export async function screenClipForAutoPost(
  videoTitle: string,
  hookCaption: string,
  postText: string,
): Promise<SafetyVerdict> {
  if (NSFW_RE.test(`${videoTitle} ${hookCaption} ${postText}`)) {
    return { allow: false, reason: "clip text matches adult-content filter" };
  }
  try {
    return await claudeVerdict(
      POST_SCREEN_PROMPT,
      [
        videoTitle ? `Source video title: ${videoTitle}` : "",
        hookCaption ? `Clip caption/hook: ${hookCaption}` : "",
        `Post text: ${postText}`,
      ].filter(Boolean).join("\n"),
    );
  } catch (e) {
    slog("clip_safety_error", { hookCaption, error: (e as Error).message });
    return { allow: false, reason: "safety check unavailable — held for review" };
  }
}
