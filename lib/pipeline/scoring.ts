import { withRetry } from "./util";
import type { DetectedCandidate } from "./types";

export interface Scored {
  score: number;     // 0-100 clip-worthiness
  rationale: string;
}

export interface Scorer {
  score(c: DetectedCandidate): Promise<Scored>;
}

/** The niche (audience description) comes from settings, so a self-hoster can point the
 *  scorer at fitness, travel, finance… without touching code. */
export function rubricPrompt(niche: string): string {
  const audience = niche.trim() || "AI / developer tooling";
  return `You are the editor for a clip account in this niche: ${audience}.
Given a long video's title, channel/speaker, and transcript, score it 0-100 on
clip-worthiness for an audience interested in ${audience}, weighting:
- authority (25): is the speaker/org high-signal in this niche?
- novelty (20): new release/announcement/genuinely new info?
- relevance (20): does this audience care right now?
- virality (20): strong claims, quotable lines, a demo, a hot take?
- freshness (10): recent + window still open?
- saturation (5, inverse): penalize already-widely-clipped.
Hard rule: the account posts English clips only — if the video's spoken language or
transcript is not English, return score 0 regardless of the rubric.
Return JSON: {"score": <int>, "rationale": "<short>"}.`;
}

function parseScore(text: string): Scored {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(match ? match[0] : text);
    const score = Math.round(Number(obj.score));
    return {
      score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0,
      rationale: String(obj.rationale ?? ""),
    };
  } catch {
    return { score: 0, rationale: `unparseable: ${text.slice(0, 120)}` };
  }
}

/** Real scorer — Claude applies the rubric to transcript + metadata via the Messages API. */
export function claudeScorer(apiKey: string, niche = "", model = "claude-sonnet-4-6"): Scorer {
  const system = rubricPrompt(niche);
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
