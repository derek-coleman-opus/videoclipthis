// Automatic, VERIFIED X-handle resolution — "tag consistently, never guess, never hold".
//
// The old rule (tags only from hand-maintained lists) was safe but starved the queue: a clip
// with no pre-listed handle was held. The new rule tags best-effort:
//
//   1. Claude PROPOSES up to 3 likely X usernames for the person/brand (knowledge, may be wrong).
//   2. Each proposal is checked against the REAL X profile (users/by/username) — name + bio must
//      actually match the person/company in context, judged by a second strict Claude pass.
//   3. Only a confident, profile-verified match is ever tagged. Everything is cached in
//      resolved_handles (including failures) so each name costs API calls exactly once.
//
// A hallucinated handle can't reach a post: the live profile lookup is the ground truth, and
// "no confident match" degrades to a text-name credit — the clip posts either way.

import { and, eq } from "drizzle-orm";
import { db, resolvedHandles } from "@/lib/db";
import { withRetry, slog } from "./util";
import { fetchUserProfile } from "./xread";

export type HandleKind = "person" | "brand";

const RESOLVER_MODEL = process.env.HANDLE_RESOLVER_MODEL ?? "claude-sonnet-4-6";
const MIN_CONFIDENCE = 0.8;

async function claudeJson(system: string, user: string, maxTokens = 200): Promise<any> {
  const data: any = await withRetry(async () => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: RESOLVER_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    return res.json();
  }, { label: "anthropic handle resolver" });
  const text: string = (data.content ?? []).map((b: any) => b.text ?? "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : text);
}

const PROPOSE_PROMPT = `You suggest X (Twitter) usernames for a given person or organization.
Return up to 3 usernames you believe ACTUALLY EXIST for the subject, best guess first, without @.
Only include usernames you have real knowledge of — never invent plausible-looking ones.
If you don't know any, return an empty list. Return JSON: {"handles": ["...", ...]}.`;

const VERIFY_PROMPT = `You verify whether an X (Twitter) profile belongs to a specific subject.
You are the last gate before a bot publicly tags this account — a wrong tag is worse than no tag,
so be strict: the profile's display name and bio must genuinely correspond to the subject (same
person/organization, matching role/company/affiliation where given). A similar name alone is NOT
a match. Return JSON: {"match": true|false, "confidence": <0..1>, "evidence": "<short>"}.`;

/** Resolve a name to a verified X handle, cached. `context` sharpens both the proposal and the
 *  verification (e.g. 'speaker in "Gemini's Audio Stack" on the Google DeepMind channel').
 *  Returns null when nothing verifies — the caller posts with a text-name credit instead. */
export async function resolveXHandle(
  kind: HandleKind,
  name: string,
  context: string,
): Promise<string | null> {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  const database = db();

  const cached = (await database
    .select().from(resolvedHandles)
    .where(and(eq(resolvedHandles.name, key), eq(resolvedHandles.kind, kind)))
    .limit(1))[0];
  if (cached) return cached.handle || null;

  let handle: string | null = null;
  let confidence = 0;
  let evidence = "";
  try {
    const proposal = await claudeJson(
      PROPOSE_PROMPT,
      `Subject (${kind}): ${name}\nContext: ${context}`,
    );
    const candidates: string[] = Array.isArray(proposal?.handles)
      ? proposal.handles.map((h: unknown) => String(h).replace(/^@/, "").trim()).filter(Boolean).slice(0, 3)
      : [];

    for (const candidate of candidates) {
      const profile = await fetchUserProfile(candidate);
      if (!profile) continue; // doesn't exist / lookup failed → cannot verify → skip
      const verdict = await claudeJson(
        VERIFY_PROMPT,
        [
          `Subject (${kind}): ${name}`,
          `Context: ${context}`,
          `Profile @${profile.username}: display name "${profile.name}", ${profile.followers} followers`,
          `Bio: ${profile.bio || "(empty)"}`,
        ].join("\n"),
      );
      if (verdict?.match === true && Number(verdict.confidence) >= MIN_CONFIDENCE) {
        handle = profile.username;
        confidence = Number(verdict.confidence);
        evidence = String(verdict.evidence ?? "").slice(0, 300);
        break;
      }
    }
  } catch (e) {
    // Resolution is best-effort: on error, don't cache — retry on a future candidate.
    slog("handle_resolve_error", { kind, name, error: (e as Error).message });
    return null;
  }

  // Cache the outcome either way — a "no handle found" answer is worth remembering too.
  await database.insert(resolvedHandles)
    .values({ kind, name: key, handle: handle ?? "", confidence, evidence })
    .onConflictDoNothing();
  slog("handle_resolved", { kind, name, handle: handle ?? "(none)", confidence });
  return handle;
}
