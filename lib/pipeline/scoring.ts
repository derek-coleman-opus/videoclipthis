import { withRetry } from "./util";
import { AI_DEVELOPER, guardrailBlock } from "./audience";
import type { DetectedCandidate } from "./types";

export interface Scored {
  score: number;     // 0-100 clip-worthiness
  rationale: string;
  /** The primary HUMAN speaker's full name — a person, never a company/channel/brand.
   *  Null when no person can be identified. Powers "tag the speaker, not the brand". */
  speakerName: string | null;
}

export interface Scorer {
  score(c: DetectedCandidate): Promise<Scored>;
}

/** The audience and the rubric both come from the active profile (see ./audience.ts), so the
 *  scorer, the curator and the editor all rank for the same reader. A bare niche string is still
 *  accepted — it falls back to the AI/developer rubric, which is what settings-only self-hosters
 *  were getting before profiles existed. */
export function rubricPrompt(niche: string, rubric?: string, guardrails: string[] = []): string {
  const audience = niche.trim() || AI_DEVELOPER.niche;
  return `You are the editor for a clip account in this niche: ${audience}.
Given a long video's title, channel/speaker, and transcript, score it 0-100 on
clip-worthiness for an audience interested in ${audience}, weighting:
${(rubric ?? AI_DEVELOPER.rubric).trim()}
${guardrailBlock(guardrails)}Hard rule: the account posts English clips only — if the video's spoken language or
transcript is not English, return score 0 regardless of the rubric.
Also identify the primary HUMAN speaker: a person's full name, never a company, channel,
or brand (conference titles often end "— Name, Company"; the transcript's self-introduction
also helps). If several speakers, pick the main one. If no person is identifiable, use null.
Return JSON: {"score": <int>, "rationale": "<short>", "speaker": "<full name>" | null}.`;
}

function parseScore(text: string): Scored {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(match ? match[0] : text);
    const score = Math.round(Number(obj.score));
    const speaker = typeof obj.speaker === "string" ? obj.speaker.trim() : "";
    return {
      score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0,
      rationale: String(obj.rationale ?? ""),
      speakerName: speaker && speaker.toLowerCase() !== "null" ? speaker : null,
    };
  } catch {
    return { score: 0, rationale: `unparseable: ${text.slice(0, 120)}`, speakerName: null };
  }
}

/** Real scorer — Claude applies the rubric to transcript + metadata via the Messages API. */
export function claudeScorer(
  apiKey: string,
  niche = "",
  model = "claude-sonnet-4-6",
  opts: { rubric?: string; guardrails?: string[] } = {},
): Scorer {
  const system = rubricPrompt(niche, opts.rubric, opts.guardrails ?? []);
  return {
    async score(c) {
      const user = [
        `Title: ${c.title}`,
        `Channel: ${c.channel ?? ""}`,
        `Speaker: ${c.speaker ?? ""}${c.figureName ? ` (tracked figure: ${c.figureName})` : ""}`,
        `Duration(s): ${c.durationS ?? 0}`,
        `Transcript:\n${(c.transcript ?? "").slice(0, 12000)}`,
      ].join("\n");
      const data: any = await withRetry(async () => {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: 300,
            system,
            messages: [{ role: "user", content: user }],
          }),
        });
        if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
        return res.json();
      }, { label: "anthropic score" });
      const text: string = (data.content ?? []).map((b: any) => b.text ?? "").join("");
      return parseScore(text);
    },
  };
}
