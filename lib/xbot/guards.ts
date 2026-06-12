import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db, xbotActions, xbotDrafts, type XbotSettings, type XbotTarget } from "@/lib/db";
import {
  BANNED_PHRASES, DUPLICATE_LOOKBACK, DUPLICATE_SIMILARITY, LOW_VALUE_PHRASES, MIN_GAP_MINUTES,
} from "./config";

/** Anti-spam guardrails. Every check reads the database, not in-memory state, because
 *  serverless invocations share nothing — the xbot_actions ledger is the source of truth. */

/** Count ledger actions of a kind since an arbitrary time. */
export async function countActionsSince(kind: string, since: Date): Promise<number> {
  const rows = await db()
    .select({ id: xbotActions.id })
    .from(xbotActions)
    .where(and(eq(xbotActions.kind, kind), gte(xbotActions.createdAt, since)));
  return rows.length;
}

/** Count ledger actions of a kind since UTC midnight (the daily-cap window). */
export async function countActionsToday(kind: string): Promise<number> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  return countActionsSince(kind, dayStart);
}

/** True if another action of this kind fits under its daily cap. */
export async function underCap(kind: string, cap: number): Promise<boolean> {
  return (await countActionsToday(kind)) < cap;
}

/** Hours per day outside quiet hours — the window daily caps are spread across. */
export function activeHoursPerDay(s: XbotSettings): number {
  const quietLen = (s.quietEndUtc - s.quietStartUtc + 24) % 24;
  return Math.max(1, 24 - quietLen);
}

/** The daily cap spread evenly across the active window, so the bot can never burn
 *  a whole day's budget in one burst — burst automation is what X's rules target. */
export function hourlyCap(dailyCap: number, s: XbotSettings): number {
  return Math.max(1, Math.ceil(dailyCap / activeHoursPerDay(s)));
}

/** When the most recent action of a kind happened, or null if there's never been one. */
export async function lastActionAt(kind: string): Promise<Date | null> {
  const rows = await db()
    .select({ createdAt: xbotActions.createdAt })
    .from(xbotActions)
    .where(eq(xbotActions.kind, kind))
    .orderBy(desc(xbotActions.createdAt))
    .limit(1);
  return rows[0]?.createdAt ?? null;
}

/** X automation-rules pacing on top of the daily caps: enforce the derived hourly cap
 *  and the per-kind minimum gap between consecutive actions. Returns a human-readable
 *  reason to wait, or null when the action may proceed now. */
export async function pacingViolation(
  kind: string,
  dailyCap: number,
  s: XbotSettings,
  now = new Date(),
): Promise<string | null> {
  const capPerHour = hourlyCap(dailyCap, s);
  const pastHour = await countActionsSince(kind, new Date(now.getTime() - 60 * 60 * 1000));
  if (pastHour >= capPerHour) {
    return `hourly ${kind} cap (${capPerHour}) reached — the daily cap is spread across active hours per X automation rules; retry within the hour`;
  }
  const gapMin = MIN_GAP_MINUTES[kind] ?? 2;
  const last = await lastActionAt(kind);
  if (last) {
    const waitMs = gapMin * 60 * 1000 - (now.getTime() - last.getTime());
    if (waitMs > 0) {
      return `pacing gap: last ${kind} was under ${gapMin} min ago — retry in ~${Math.ceil(waitMs / 60000)} min`;
    }
  }
  return null;
}

/** Engagement pauses during quiet hours (UTC); handles windows that wrap midnight. */
export function inQuietHours(s: XbotSettings, now = new Date()): boolean {
  const h = now.getUTCHours();
  const { quietStartUtc: start, quietEndUtc: end } = s;
  if (start === end) return false;
  return start < end ? h >= start && h < end : h >= start || h < end;
}

/** Don't reply to the same person again within the cooldown window. */
export function targetInCooldown(target: XbotTarget, cooldownDays: number, now = new Date()): boolean {
  if (!target.lastRepliedAt) return false;
  const elapsedMs = now.getTime() - new Date(target.lastRepliedAt).getTime();
  return elapsedMs < cooldownDays * 24 * 60 * 60 * 1000;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function wordOverlap(a: string, b: string): number {
  const wa = new Set(normalize(a).split(" ").filter(Boolean));
  const wb = new Set(normalize(b).split(" ").filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared); // Jaccard
}

/** Reject drafts that violate the growth method: "let's connect"-style follower bait
 *  anywhere, and replies that are mostly generic praise ("Good post", "Best of luck").
 *  Returns a human-readable reason, or null when the draft is fine. */
export function lowValueReason(text: string, kind: string): string | null {
  const norm = normalize(text);
  // Normalized phrases are alphanumerics+spaces, so they're regex-safe as-is.
  const phraseRe = (phrase: string) => new RegExp(`\\b${normalize(phrase)}\\b`, "g");
  for (const phrase of BANNED_PHRASES) {
    if (phraseRe(phrase).test(norm)) {
      return `contains follower-bait phrase "${phrase}" — these get follows that never engage`;
    }
  }
  if (kind === "reply" || kind === "followup") {
    let stripped = norm;
    for (const phrase of LOW_VALUE_PHRASES) {
      stripped = stripped.replace(phraseRe(phrase), " ");
    }
    const remaining = stripped.split(" ").filter(Boolean).length;
    if (remaining < 5) {
      return "reply is mostly generic praise — make it funny, contrarian, or concretely useful";
    }
  }
  return null;
}

/** Reject drafts that exactly match or heavily overlap recent posted/approved drafts —
 *  duplicate reply text is a classic spam signal X looks for. */
export async function isDuplicateText(text: string): Promise<boolean> {
  const recent = await db()
    .select({ text: xbotDrafts.text })
    .from(xbotDrafts)
    .where(inArray(xbotDrafts.status, ["approved", "scheduled", "posted"]))
    .orderBy(desc(xbotDrafts.createdAt))
    .limit(DUPLICATE_LOOKBACK);
  const candidate = normalize(text);
  return recent.some(
    (r) => normalize(r.text) === candidate || wordOverlap(r.text, text) > DUPLICATE_SIMILARITY,
  );
}
