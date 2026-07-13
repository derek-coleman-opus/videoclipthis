// Account-survival guardrails, born from an actual account lock. Three layers on top of the
// operator-tunable caps in xbot_settings:
//
//   1. HARD ceilings the settings UI cannot exceed — X locks accounts for volume long before
//      the API complains, so the code owns the real maximum, not the operator.
//   2. A ramp: automation that goes 0→full-speed on day one is the classic lock trigger.
//      Effective caps scale up over the first three weeks of ledger history.
//   3. A lock circuit-breaker: the moment any write fails with an account-locked/suspended
//      error, the bot pauses itself (paused=true) so the cron can't keep hammering a locked
//      account — continued automation during a lock is how locks become suspensions. After
//      the operator unlocks and unpauses, caps stay throttled for two weeks.

import { asc } from "drizzle-orm";
import { db, xbotActions, type XbotSettings } from "@/lib/db";
import { logEvent } from "@/lib/pipeline/events";
import { slog } from "@/lib/pipeline/util";
import { reportHealth } from "./health";
import { updateXbotSettings } from "./settings";

/** Absolute per-day maxima, regardless of settings. X's spam systems tolerate far less
 *  than the API allows; these sit well under commonly-reported lock thresholds. */
export const HARD_DAILY_CAPS = { like: 80, reply: 20, engage: 30, post: 5 } as const;
export type CapKind = keyof typeof HARD_DAILY_CAPS;

/** How long after a detected lock ALL writes stay frozen, even if the operator unpauses —
 *  acting on a freshly-locked account before verification clears makes things worse. */
const LOCK_FREEZE_HOURS = 48;

/** True when this X error means the ACCOUNT is locked/restricted/suspended (not a normal
 *  rate limit or permission problem). Matches both v2 detail strings and v1.1 error codes
 *  (326 = temporarily locked, 64 = suspended) as serialized by describeXbotError. */
export function isAccountLockError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("temporarily locked") ||
    m.includes("account is locked") ||
    m.includes("to protect our users from spam") ||
    m.includes("suspended") ||
    /"code"\s*:\s*(326|64)\b/.test(m) ||
    /\(326\)|\(64\)/.test(message)
  );
}

/** Circuit breaker: pause the whole bot and record the lock. Never throws. */
export async function tripAccountLock(reason: string): Promise<void> {
  try {
    await updateXbotSettings({ paused: true, lockDetectedAt: new Date(), lockReason: reason.slice(0, 500) });
    await reportHealth("account", false, reason);
    await logEvent("xbot_error", `🔒 X ACCOUNT LOCK detected — bot auto-paused. ${reason.slice(0, 200)}`);
    slog("xbot_account_lock", { reason });
  } catch (e) {
    slog("xbot_account_lock_trip_error", { error: (e as Error).message });
  }
}

/** Freeze window after a lock: no writes at all, even when unpaused. */
export function inLockFreeze(s: XbotSettings, now = new Date()): boolean {
  if (!s.lockDetectedAt) return false;
  return now.getTime() - s.lockDetectedAt.getTime() < LOCK_FREEZE_HOURS * 3600_000;
}

/** Days since the bot's first ledger action — the automation age the ramp keys off. */
export async function automationAgeDays(now = new Date()): Promise<number> {
  const rows = await db()
    .select({ createdAt: xbotActions.createdAt })
    .from(xbotActions)
    .orderBy(asc(xbotActions.createdAt))
    .limit(1);
  const first = rows[0]?.createdAt;
  if (!first) return 0;
  return Math.floor((now.getTime() - first.getTime()) / 86_400_000);
}

/** Ramp multiplier: start slow, reach full speed after three weeks of history. */
function rampFraction(ageDays: number): number {
  if (ageDays < 7) return 0.3;
  if (ageDays < 14) return 0.5;
  if (ageDays < 21) return 0.75;
  return 1;
}

/** Post-lock multiplier: quarter speed the first week after a lock, half the second. */
function lockFraction(s: XbotSettings, now = new Date()): number {
  if (!s.lockDetectedAt) return 1;
  const days = (now.getTime() - s.lockDetectedAt.getTime()) / 86_400_000;
  if (days < 7) return 0.25;
  if (days < 14) return 0.5;
  return 1;
}

/** Deterministic ±15% day-to-day jitter so daily volume isn't a robotic flat line.
 *  Seeded from the UTC date (not Math.random) so every invocation agrees on today's cap. */
function dayJitter(now = new Date()): number {
  const key = now.toISOString().slice(0, 10);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return 0.85 + (h % 31) / 100; // 0.85 .. 1.15
}

export interface EffectiveCaps {
  like: number;
  reply: number;
  engage: number;
  post: number;
  /** Human-readable reason when caps are below the configured values, for the dashboard. */
  throttleNote: string | null;
}

/** The caps the workers actually enforce: min(settings, hard ceiling) × ramp × post-lock
 *  throttle, with day jitter on likes (the highest-volume, most lock-prone action). */
export async function effectiveCaps(s: XbotSettings, now = new Date()): Promise<EffectiveCaps> {
  const age = await automationAgeDays(now);
  const ramp = rampFraction(age);
  const lock = lockFraction(s, now);
  const scale = ramp * lock;

  const capped = (kind: CapKind, configured: number): number =>
    Math.max(1, Math.round(Math.min(configured, HARD_DAILY_CAPS[kind]) * scale));

  const notes: string[] = [];
  if (ramp < 1) notes.push(`ramp-up week ${Math.floor(age / 7) + 1} (${Math.round(ramp * 100)}% of caps)`);
  if (lock < 1) notes.push(`post-lock cooldown (${Math.round(lock * 100)}% of caps)`);

  return {
    like: Math.max(1, Math.round(capped("like", s.dailyLikeCap) * dayJitter(now))),
    reply: capped("reply", s.dailyReplyCap),
    engage: capped("engage", s.dailyEngageCap),
    post: capped("post", s.dailyPostCap),
    throttleNote: notes.length ? notes.join(" + ") : null,
  };
}
