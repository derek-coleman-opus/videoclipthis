// The EDITOR — the gate that decides whether a finished render is worth posting, and writes the
// hook if it is.
//
// Why this exists: the scout rubric (scoring.ts) judges a whole SOURCE VIDEO — is this speaker
// high-signal, is this fresh — and OpusClip's hookScore judges a segment's *retention* shape.
// Neither one asks the only question that decides whether a dev shares a clip: does this say
// something specific enough to argue with? Without this pass the pipeline posted whatever came
// back highest-scored, which is how you end up with six clips a day of a well-known person
// saying something agreeable.
//
// Two jobs, one Claude call per candidate:
//   1. PICK the best of the renders OpusClip produced (we pay per source minute, so every clip
//      in the project is already bought and paid for — using only the first was waste).
//   2. VETO the whole candidate when none of them clears the bar, and write the verbatim pull
//      quote for the winner's hook.
//
// Fail-open by design: if Claude is unreachable, a paid render must not be thrown away. On error
// we return a null verdict and the caller falls back to the old caption-based hook. A broken
// editor degrades the timeline; it must never delete inventory.

import { withRetry, slog } from "./util";
import { AI_DEVELOPER, guardrailBlock } from "./audience";

const EDITOR_MODEL = process.env.EDITORIAL_MODEL ?? "claude-sonnet-4-6";

/** Clips scoring below this are not posted. Tuned so roughly half of renders are rejected —
 *  that is the point, not a bug: the daily cap should be a ceiling, never a quota to fill. */
export const EDITORIAL_MIN_SCORE = Number(process.env.EDITORIAL_MIN_SCORE ?? 65);

/** How many of a project's renders the editor compares. Each is a few hundred tokens of prompt;
 *  three is enough to escape a bad top-ranked pick without turning review into the cost centre. */
export const EDITORIAL_MAX_OPTIONS = Number(process.env.EDITORIAL_MAX_OPTIONS ?? 3);

/** One rendered clip offered to the editor. */
export interface ClipOption {
  caption: string;    // OpusClip's clip title
  durationS: number;
  hookScore: number;  // OpusClip's own virality score (0-99)
}

export interface EditorialVerdict {
  /** Index into the options array — which render to post. */
  pick: number;
  /** 0-100 shareability. Below EDITORIAL_MIN_SCORE the clip is not posted. */
  score: number;
  /** Verbatim sentence from the clip, used as the post's first line. "" when none is usable. */
  pullQuote: string;
  /** Short reason, shown in the admin so a rejection is never silent. */
  note: string;
}

export interface EditorialInput {
  title: string;
  speaker?: string;
  channel?: string;
  /** Source transcript. The editor locates the clip inside it to quote it accurately. */
  transcript?: string;
  options: ClipOption[];
  niche?: string;
  /** Pull quotes from this account's best-performing past clips, as calibration. */
  winners?: string[];
  /** Clip-level rubric, floor and refusals from the active audience profile. Absent → the
   *  AI/developer defaults, which is what callers got before profiles existed. */
  editorialRubric?: string;
  editorialFloor?: string;
  guardrails?: string[];
}

function systemPrompt(
  niche: string,
  winners: string[],
  rubric?: string,
  floor?: string,
  guardrails: string[] = [],
): string {
  const audience = niche.trim() || AI_DEVELOPER.niche;
  const calibration = winners.length
    ? `\n\nThese hooks are from this account's best-performing past clips — match this register:\n${winners.map((w) => `- ${w}`).join("\n")}`
    : "";
  return `You are the editor of a clip account whose audience is ${audience}. You are ruthless,
because the account's problem is posting too much forgettable material, not too little.

You will be given a source video's transcript and several candidate clips cut from it (by title).
Pick the best one and score it 0-100 on SHAREABILITY — the odds someone in this audience stops
scrolling, then passes it on:
${(rubric ?? AI_DEVELOPER.editorialRubric).trim()}

Score 40 or below — which means the clip does not get posted — for any of these, no matter how
famous the speaker is: ${(floor ?? AI_DEVELOPER.editorialFloor).trim()} Being said by a famous
person is not a reason to post it. Most clips are genuinely not worth posting; say so.
${guardrailBlock(guardrails)}

Then write the PULL QUOTE: the single most arresting sentence the speaker actually says in the
clip you picked, copied VERBATIM from the transcript. Never paraphrase, never invent, never clean
it up beyond trimming filler words. Max 200 characters — if the strongest sentence is longer,
quote the sharpest complete clause inside it. If the transcript doesn't let you quote the chosen
clip accurately, return "" rather than guessing.${calibration}

Return ONLY JSON: {"pick": <0-based index>, "score": <int 0-100>, "pullQuote": "<verbatim or empty>", "note": "<one short sentence on why>"}`;
}

function parseVerdict(text: string, optionCount: number): EditorialVerdict | null {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : text);
    const pickRaw = Math.round(Number(obj.pick));
    const pick = Number.isFinite(pickRaw) && pickRaw >= 0 && pickRaw < optionCount ? pickRaw : 0;
    const scoreRaw = Math.round(Number(obj.score));
    const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(100, scoreRaw)) : 0;
    const quote = typeof obj.pullQuote === "string" ? obj.pullQuote.trim() : "";
    return {
      pick,
      score,
      // Strip quote marks the model may have wrapped it in — production.ts adds its own.
      pullQuote: quote.replace(/^["“”'']+|["“”'']+$/g, "").slice(0, 200),
      note: String(obj.note ?? "").slice(0, 300),
    };
  } catch {
    return null;
  }
}

/** Judge a project's renders. Returns null when the editor could not run — callers MUST treat
 *  null as "no opinion" and post the top-ranked clip, never as a rejection. */
export async function reviewClips(input: EditorialInput): Promise<EditorialVerdict | null> {
  if (!input.options.length) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) return null;

  const options = input.options.slice(0, EDITORIAL_MAX_OPTIONS);
  const user = [
    `Source video: ${input.title}`,
    input.speaker ? `Speaker: ${input.speaker}` : "",
    input.channel ? `Channel: ${input.channel}` : "",
    "",
    "Candidate clips:",
    ...options.map((o, i) =>
      `[${i}] "${o.caption}" — ${Math.round(o.durationS)}s (OpusClip hook score ${o.hookScore})`),
    "",
    input.transcript
      ? `Source transcript:\n${input.transcript.slice(0, 14000)}`
      : "Source transcript: (unavailable — judge from the clip titles alone and return \"\" as the pull quote)",
  ].filter(Boolean).join("\n");

  try {
    const data: any = await withRetry(async () => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: EDITOR_MODEL,
          max_tokens: 500,
          system: systemPrompt(
            input.niche ?? "", input.winners ?? [],
            input.editorialRubric, input.editorialFloor, input.guardrails ?? [],
          ),
          messages: [{ role: "user", content: user }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
      return res.json();
    }, { label: "anthropic editorial" });
    const text: string = (data.content ?? []).map((b: any) => b.text ?? "").join("");
    const verdict = parseVerdict(text, options.length);
    if (!verdict) slog("editorial_unparseable", { title: input.title, text: text.slice(0, 200) });
    return verdict;
  } catch (e) {
    // Fail open: a paid render is worth more than a missed veto.
    slog("editorial_error", { title: input.title, error: (e as Error).message });
    return null;
  }
}

/** Did this verdict clear the bar? A null verdict (editor unavailable) always passes.
 *
 *  `minScore` comes from the active audience profile — the right bar differs by lane, and a floor
 *  tuned for one audience silently starves the other. EDITORIAL_MIN_SCORE remains the default so
 *  the env var keeps working as an override for self-hosters. */
export function editorialPasses(v: EditorialVerdict | null, minScore = EDITORIAL_MIN_SCORE): boolean {
  return !v || v.score >= minScore;
}
