// Our side of the X invoice: every outbound tweet the clip account sends is recorded here,
// success or failure, so the X console's billed-post count is always explainable. Never
// throws — accounting must not break the write it accounts for.

import { gte } from "drizzle-orm";
import { db, xWrites } from "@/lib/db";
import { slog } from "./util";

export type XWriteKind = "clip_post" | "summon_clip" | "summon_ack" | "summon_service" | "manual_post";

export async function recordXWrite(entry: {
  kind: XWriteKind | string;
  ok: boolean;
  tweetId?: string | null;
  replyTo?: string | null;
  detail?: string;
}): Promise<void> {
  try {
    await db().insert(xWrites).values({
      kind: entry.kind,
      ok: entry.ok,
      tweetId: entry.tweetId ?? null,
      replyTo: entry.replyTo ?? null,
      detail: (entry.detail ?? "").slice(0, 300),
    });
  } catch (e) {
    slog("x_write_ledger_error", { kind: entry.kind, error: (e as Error).message });
  }
}

export interface XWriteStats {
  sinceHours: number;
  total: number;
  ok: number;
  failed: number;
  byKind: Record<string, number>;
}

/** Write counts for a window — diagnostics shows this next to the X console's numbers. */
export async function xWriteStats(sinceHours: number): Promise<XWriteStats> {
  const since = new Date(Date.now() - sinceHours * 3600_000);
  const rows = await db()
    .select({ kind: xWrites.kind, ok: xWrites.ok })
    .from(xWrites)
    .where(gte(xWrites.createdAt, since));
  const byKind: Record<string, number> = {};
  let ok = 0;
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    if (r.ok) ok++;
  }
  return { sinceHours, total: rows.length, ok, failed: rows.length - ok, byKind };
}

/** Count of successful service replies (instructions / too-short / bad-host) in a window —
 *  these are goodwill spend, not content, so they get their own daily budget. */
export async function serviceRepliesSince(sinceHours: number): Promise<number> {
  const stats = await xWriteStats(sinceHours);
  return stats.byKind["summon_service"] ?? 0;
}
