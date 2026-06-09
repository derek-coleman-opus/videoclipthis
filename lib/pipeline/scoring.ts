import { HIGH_AUTHORITY_CHANNELS } from "./config";
import { withRetry } from "./util";
import type { DetectedCandidate } from "./types";

export interface Scored {
  score: number;     // 0-100 clip-worthiness
  rationale: string;
}

export interface Scorer {
  score(c: DetectedCandidate): Promise<Scored>;
}

export const RUBRIC_PROMPT = `You are the editor for a developer/AI clip account.
Given a long video's title, channel/speaker, and transcript, score it 0-100 on
clip-worthiness for an audience of AI/dev builders, weighting:
- authority (25): is the speaker/org high-signal?
- novelty (20): new release/announcement/genuinely new info?
- relevance (20): do AI/dev builders care right now?
- virality (20): strong claims, quotable lines, a demo, a hot take?
- freshness (10): recent + window still open?
- saturation (5, inverse): penalize already-widely-clipped.
Return JSON: {"score": <int>, "rationale": "<short>"}.`;

/** Heuristic scorer for mock mode / tests — no LLM call. */
export const mockScorer: Scorer = {
  async score(c) {
    let s = 50;
    if (HIGH_AUTHORITY_CHANNELS.has((c.channel ?? "").toLowerCase())) s += 30;
    const hot = ["agents", "demo", "nobody expects", "live", "2027", "refactor"];
    const t = (c.transcript ?? "").toLowerCase();
    if (hot.some((w) => t.includes(w))) s += 10;
    if (c.figureName) s += 20; // a tracked key AI figure is involved
    if ((c.durationS ?? 0) < 900) s -= 20; // very short / likely filler
    s = Math.max(0, Math.min(100, s));
    return { score: s, rationale: "mock heuristic" };
  },
};

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
export function claudeScorer(apiKey: string, model = "claude-sonnet-4-6"): Scorer {
  return {
    async score(c) {
      // TODO-LIVE: needs ANTHROPIC_API_KEY; confirm model id + response shape against the current API.
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
            system: RUBRIC_PROMPT,
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
