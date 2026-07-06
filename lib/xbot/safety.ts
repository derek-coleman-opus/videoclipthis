import { slog, withRetry } from "@/lib/pipeline/util";
import { XBOT_MODEL } from "./config";

/** Brand-safety gate for UNATTENDED auto-posts. Manual approvals skip this (a human already
 *  judged them). Fail-safe: any uncertainty or error → not safe → the draft is held for review,
 *  never auto-posted. Held drafts still appear in the queue for a one-tap human decision. */

export interface SafetyVerdict {
  safe: boolean;
  reason?: string;
}

/** High-precision keyword prefilter — unambiguous no-go territory for an auto-reply. Kept tight
 *  so it doesn't over-hold normal dev/AI talk; the Claude pass below handles the nuanced cases. */
const SENSITIVE: { label: string; re: RegExp }[] = [
  { label: "death/grief", re: /\b(died|passed away|r\.?i\.?p\.?|funeral|obituary|condolences?|suicide|self[-\s]?harm|mourning|heartbroken)\b/i },
  { label: "mass violence", re: /\b(mass shooting|shooter|terror(ist|ism)?|massacre|hostages?|bombing)\b/i },
  { label: "politics", re: /\b(trump|biden|kamala|maga|election|abortion|gaza|palestine|israel|genocide|far[-\s]?(right|left))\b/i },
  { label: "nsfw", re: /\b(nsfw|onlyfans|porn|nudes?)\b/i },
];

function prefilter(text: string): string | null {
  for (const p of SENSITIVE) if (p.re.test(text)) return p.label;
  return null;
}

const SAFETY_PROMPT = `You are a brand-safety gate for an automated X reply that posts with NO human review.
Decide if it's safe to auto-post. It is NOT safe if the ORIGINAL tweet is about anything sensitive
(death/grief, politics/elections, war/violence/tragedy, serious medical or mental-health struggles,
legal trouble, financial/investment advice, NSFW, or an active pile-on/outrage), OR if OUR reply could
read as insensitive, argumentative, preachy, tone-deaf, unsolicited-advice, or off-brand for a friendly
builder. When unsure, answer not safe.
Return JSON: {"safe": true|false, "reason": "<short>"}.`;

/** Judge whether a draft is safe to auto-post. `targetText` is the tweet we're replying to
 *  (empty for our own original posts, which are judged on our text alone). */
export async function assessAutoPost(
  kind: string,
  targetText: string,
  draftText: string,
): Promise<SafetyVerdict> {
  const isReply = kind !== "post";
  if (isReply) {
    const label = prefilter(targetText || "");
    if (label) return { safe: false, reason: `target tweet looks ${label}` };
  }

  try {
    const model = process.env.XBOT_SAFETY_MODEL ?? XBOT_MODEL;
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    const data: any = await withRetry(async () => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 150,
          system: SAFETY_PROMPT,
          messages: [{
            role: "user",
            content: isReply
              ? `Original tweet:\n${targetText || "(unknown)"}\n\nOur reply:\n${draftText}`
              : `Our standalone post (no reply target):\n${draftText}`,
          }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
      return res.json();
    }, { label: "anthropic xbot safety" });

    const text: string = (data.content ?? []).map((b: any) => b.text ?? "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : text);
    return obj?.safe === true ? { safe: true } : { safe: false, reason: String(obj?.reason ?? "flagged by safety check") };
  } catch (e) {
    slog("xbot_safety_error", { error: (e as Error).message });
    return { safe: false, reason: "safety check unavailable — held for manual review" };
  }
}
