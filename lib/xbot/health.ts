// The "why did it stop" ledger. Every XBot worker reports each run's outcome here; the
// dashboard turns failing components into a loud red banner with a plain-English reason —
// so an exhausted API cap or billing problem can never silently stall the bot again.

import { eq, sql } from "drizzle-orm";
import { db, xbotHealth, type XbotHealth } from "@/lib/db";
import { slog } from "@/lib/pipeline/util";

export type XbotComponent =
  | "outbound" | "harvest" | "likes" | "posting" | "inbound" | "discover" | "account"
  | "summon"; // clip pipeline's mention poll reports here too — same ledger, same "never silent" rule

/** Human labels + what each component does, for the dashboard banner. */
export const COMPONENT_LABEL: Record<XbotComponent, string> = {
  outbound: "Outbound (roster timelines → reply drafts + like supply)",
  harvest: "Like harvesting (keyword search → like supply)",
  likes: "Auto-likes",
  posting: "Posting (auto replies/posts)",
  inbound: "Inbound (engage-backs)",
  discover: "Target discovery",
  account: "X account status",
  summon: "Summon (@videoclipthis mention poll)",
};

/** Translate an X API error into plain English + what the operator should do. */
export function explainXError(message: string): string {
  const m = message.toLowerCase();
  if (
    m.includes("temporarily locked") || m.includes("account is locked") ||
    m.includes("to protect our users from spam") || m.includes("suspended") ||
    /"code"\s*:\s*(326|64)\b/.test(m)
  ) {
    return `X ACCOUNT LOCKED/RESTRICTED — the bot auto-paused itself. Log into x.com, complete the verification challenge, wait ~48h, then unpause; caps stay reduced for two weeks. (${message.slice(0, 200)})`;
  }
  if (m.includes("usagecapexceeded") || m.includes("usage cap") || m.includes("cap exceeded")) {
    return `X API monthly usage cap exhausted — top up / upgrade the X API plan or wait for the monthly reset. (${message.slice(0, 200)})`;
  }
  if (m.includes("429") || m.includes("rate limit") || m.includes("toomanyrequests")) {
    return `X rate limit — resumes automatically at the reset time. (${message.slice(0, 200)})`;
  }
  if (m.includes("402") || m.includes("payment") || m.includes("credit") || m.includes("billing")) {
    return `X API payment/credits issue — top up billing on the X developer portal. (${message.slice(0, 200)})`;
  }
  if (m.includes("401") || m.includes("unauthorized")) {
    return `X auth rejected — the XBOT_* keys are wrong or revoked. (${message.slice(0, 200)})`;
  }
  if (m.includes("403") || m.includes("forbidden") || m.includes("oauth")) {
    return `X permission rejected — check the app's Read+Write permission / access level. (${message.slice(0, 200)})`;
  }
  return message.slice(0, 300);
}

/** Upsert a component's run outcome. Never throws — health reporting must not break the worker. */
export async function reportHealth(component: XbotComponent, ok: boolean, error?: string): Promise<void> {
  try {
    const now = new Date();
    const explained = ok ? "" : explainXError(error ?? "unknown error");
    await db().insert(xbotHealth).values({
      component,
      lastRunAt: now,
      lastOkAt: ok ? now : null,
      lastErrorAt: ok ? null : now,
      lastError: explained,
      consecutiveErrors: ok ? 0 : 1,
    }).onConflictDoUpdate({
      target: xbotHealth.component,
      set: ok
        ? { lastRunAt: now, lastOkAt: now, consecutiveErrors: 0 }
        : {
            lastRunAt: now, lastErrorAt: now, lastError: explained,
            consecutiveErrors: sql`${xbotHealth.consecutiveErrors} + 1`,
          },
    });
  } catch (e) {
    slog("xbot_health_report_error", { component, error: (e as Error).message });
  }
}

/** All health rows, for the dashboard banner + diagnostics. */
export async function getXbotHealth(): Promise<XbotHealth[]> {
  return db().select().from(xbotHealth);
}

/** Components currently failing: their latest run errored (lastErrorAt >= lastOkAt). */
export function failingComponents(rows: XbotHealth[]): XbotHealth[] {
  return rows.filter((r) => {
    if (!r.lastErrorAt) return false;
    if (!r.lastOkAt) return true;
    return r.lastErrorAt.getTime() >= r.lastOkAt.getTime();
  });
}

export interface XUsage {
  used: number | null;
  cap: number | null;
  resetDay: number | null; // day-of-month the cap resets
  error?: string;
}

/** Project-level post-read consumption from X's own usage endpoint — the early warning for
 *  "the API is about to run out". Best-effort: an error is reported, never thrown. */
export async function fetchXUsage(): Promise<XUsage> {
  try {
    const { TwitterApi } = await import("twitter-api-v2");
    const bearer = process.env.XBOT_BEARER_TOKEN ?? "";
    if (!bearer) return { used: null, cap: null, resetDay: null, error: "no XBOT_BEARER_TOKEN" };
    const client = new TwitterApi(bearer);
    const res: any = await client.v2.get("usage/tweets");
    const d = res?.data ?? res;
    return {
      used: d?.project_usage != null ? Number(d.project_usage) : null,
      cap: d?.project_cap != null ? Number(d.project_cap) : null,
      resetDay: d?.cap_reset_day != null ? Number(d.cap_reset_day) : null,
    };
  } catch (e) {
    return { used: null, cap: null, resetDay: null, error: explainXError((e as Error).message) };
  }
}
