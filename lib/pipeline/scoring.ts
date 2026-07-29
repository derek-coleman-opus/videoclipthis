import { withRetry } from "./util";
import type { DetectedCandidate } from "./types";

export interface Scored {
  score: number;     // 0-100 clip-worthiness
  rationale: string;
  /** The primary HUMAN speaker's full name — a person, never a company/channel/brand.
   *  Null when no person can be identified. Powers "tag the speaker, not the brand". */
  speakerName: string | null;
  /** Companies/products central to the content — candidates for verified entity tags. */
  entities: string[];
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
- visual format (25): will this look ALIVE as a vertical 9:16 clip? Podcasts, sit-down
  interviews, fireside chats, and on-stage keynotes with a camera on the speaker score high.
  Slide presentations, screen-shares, code walkthroughs, and webinars where the speaker is a
  voice over a deck score VERY low — a cropped slide with a disembodied voice is a dead clip.
  Judge from the channel type, title, and description (e.g. "podcast", "interview", "Ep.",
  "sits down with", "fireside" vs "talk", "session", "demo", "workshop", "conference").
- authority (20): is the speaker/org high-signal in this niche?
- virality (20): strong claims, quotable lines, a hot take?
- novelty (15): new release/announcement/genuinely new info?
- relevance (10): does this audience care right now?
- freshness (5): recent + window still open?
- saturation (5, inverse): penalize already-widely-clipped.
Hard rule: the account posts English clips only — if the video's spoken language or
transcript is not English, return score 0 regardless of the rubric.
Also identify the primary HUMAN speaker: a person's full name, never a company, channel,
or brand (conference titles often end "— Name, Company"; the transcript's self-introduction
also helps). If several speakers, pick the main one. If no person is identifiable, use null.
Also list up to 3 companies/products/organizations CENTRAL to what is discussed (not merely
name-dropped) — these become who the post tags on X, so pick entities whose accounts would
plausibly care about this clip. [] if none.
Return JSON: {"score": <int>, "rationale": "<short>", "speaker": "<full name>" | null,
"entities": ["<org/product>", ...]}.`;
}

function parseScore(text: string): Scored {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(match ? match[0] : text);
    const score = Math.round(Number(obj.score));
    const speaker = typeof obj.speaker === "string" ? obj.speaker.trim() : "";
    const entities = Array.isArray(obj.entities)
      ? obj.entities.map((e: unknown) => String(e).trim()).filter(Boolean).slice(0, 3)
      : [];
    return {
      score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0,
      rationale: String(obj.rationale ?? ""),
      speakerName: speaker && speaker.toLowerCase() !== "null" ? speaker : null,
      entities,
    };
  } catch {
    return { score: 0, rationale: `unparseable: ${text.slice(0, 120)}`, speakerName: null, entities: [] };
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
