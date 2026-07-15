// Phase B of the clip step: collect finished OpusClip renders, then drain the posting queue.
//
// Scout/Summon submit a render and persist the project id on the candidate (status "rendering"),
// then move on — no request ever waits on a render. This collector runs at the top of every
// scout and summon cycle: one cheap status check per in-flight candidate. Finished renders become
// clip ROWS FIRST (so a publish failure can never lose a paid render), and publishing happens in
// a separate drain step that paces auto-posts (daily cap + minimum gap) so the account never
// bursts. Summon replies skip the cap/pacing — a human asked.

import { and, desc, eq, gte, isNotNull, lt } from "drizzle-orm";
import { db, candidates, clips, summonRequests, type Candidate, type Clip, type Settings } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { MIN_CLIP_POST_GAP_MIN } from "./config";
import { opusclipFetchClips, type OpusClipResult } from "./opusclip";
import { crossPostClip } from "./crosspost";
import { screenClipForAutoPost } from "./clipSafety";
import { composePost } from "./production";
import { xPublisher } from "./publishing";
import { hasXEnv } from "./env";
import { logEvent } from "./events";
import { slog } from "./util";
import type { DetectedCandidate, Moment } from "./types";

/** Give a render this long AFTER SUBMISSION before declaring it dead. */
const RENDER_TIMEOUT_H = Number(process.env.RENDER_TIMEOUT_H ?? 2);

/** Pending-review clips older than this are stale — the moment has passed, so expire them
 *  (we only want to post NEW content). Env-overridable. */
const CLIP_REVIEW_TTL_H = Number(process.env.CLIP_REVIEW_TTL_H ?? 6);

export interface CollectResult {
  checked: number;
  collected: number;
  posted: number;
  failed: number;
  expired: number;
}

/** Drop review-queue clips that have gone stale (older than the review TTL). */
export async function expireStaleClips(): Promise<number> {
  const cutoff = new Date(Date.now() - CLIP_REVIEW_TTL_H * 3600 * 1000);
  const rows = await db().update(clips)
    .set({ status: "expired" })
    .where(and(eq(clips.status, "pending_review"), lt(clips.createdAt, cutoff)))
    .returning({ id: clips.id });
  if (rows.length) {
    await logEvent("run", `Expired ${rows.length} stale review clip(s) (>${CLIP_REVIEW_TTL_H}h old)`);
  }
  return rows.length;
}

function toDetected(row: Candidate): DetectedCandidate {
  return {
    source: row.source,
    url: row.url,
    videoId: row.videoId,
    title: row.title,
    speaker: row.speaker ?? "",
    speakerHandle: row.speakerHandle ?? "",
    channel: row.channel ?? "",
    event: row.event ?? "",
    durationS: row.durationS ?? 0,
    figureName: row.figureName ?? undefined,
  };
}

function toMoment(best: OpusClipResult): Moment {
  return {
    startS: best.startS,
    endS: best.endS,
    hookCaption: best.caption || "the moment worth watching",
    confidence: Math.min(1, best.score / 100),
    clipUrl: best.clipUrl,
    costUsd: best.costUsd,
  };
}

/** Check every in-flight render; finished ones become clip rows; stale ones fail.
 *  Then drain the posting queue (paced). */
export async function collectRenders(): Promise<CollectResult> {
  const database = db();
  const cfg = await getSettings();
  const apiKey = process.env.OPUSCLIP_API_KEY ?? "";
  const base = process.env.OPUSCLIP_API_BASE ?? "";

  const inFlight = await database
    .select()
    .from(candidates)
    .where(and(eq(candidates.status, "rendering"), isNotNull(candidates.opusProjectId)));

  // Expire stale review-queue clips first (only post NEW content).
  const expiredClips = await expireStaleClips();

  let collected = 0;
  let failed = 0;

  for (const row of inFlight) {
    // Timeout clock starts at SUBMISSION, not detection — a candidate can legitimately wait
    // hours as "scored" for a free render slot before it is ever submitted.
    const startedAt = row.renderStartedAt ?? row.detectedAt ?? row.createdAt ?? new Date();
    const ageMs = Date.now() - new Date(startedAt).getTime();
    const expired = ageMs > RENDER_TIMEOUT_H * 3600 * 1000;

    let clipsReady: OpusClipResult[] = [];
    let done = false;
    try {
      const res = await opusclipFetchClips(row.opusProjectId as string, apiKey, base);
      clipsReady = res.clips.filter((c) => c.clipUrl && !c.renderPending).sort((a, b) => b.score - a.score);
      done = res.done;
    } catch (e) {
      // Transient check failure: leave it rendering unless it's already stale.
      if (!expired) continue;
      await database.update(candidates).set({ status: "failed" }).where(eq(candidates.id, row.id));
      await logEvent("error", `Render check failed for "${row.title}": ${(e as Error).message}`, "candidates", row.id);
      failed++;
      continue;
    }

    // Still rendering: take a partial result once it's stale, otherwise keep waiting.
    if (!done && !(expired && clipsReady.length)) {
      if (expired) {
        await database.update(candidates).set({ status: "failed" }).where(eq(candidates.id, row.id));
        await logEvent("error", `Render timed out (no clips after ${RENDER_TIMEOUT_H}h): ${row.title}`, "candidates", row.id);
        failed++;
      }
      continue;
    }

    const moment = toMoment(clipsReady[0]);
    const d = toDetected(row);
    const postText = composePost(d, moment);

    // Summon candidates reply in-thread (always auto); scout clips obey the autonomy gate.
    const summonReq = row.source === "summon"
      ? (await database.select().from(summonRequests).where(eq(summonRequests.candidateId, row.id)).limit(1))[0]
      : undefined;
    let autoPost = row.source === "summon" || cfg.autonomy === "auto";

    // Unattended posts get a final content screen (adult/violent/hate/harassment → held for a
    // human). Manual review-mode clips skip it — the human approval IS the screen.
    let holdReason = "";
    if (autoPost) {
      const screen = await screenClipForAutoPost(row.title, moment.hookCaption, postText);
      if (!screen.allow) {
        autoPost = false;
        holdReason = screen.reason;
      }
    }

    // Insert the clip row BEFORE any publish attempt — the paid render is never lost to a
    // publish failure, and there is no orphan-tweet window.
    const [clip] = await database.insert(clips).values({
      candidateId: row.id, startS: moment.startS, endS: moment.endS,
      hookCaption: moment.hookCaption, postText, clipUrl: moment.clipUrl,
      opusClipId: clipsReady[0].clipId || null,
      kind: row.source === "summon" ? "summon" : "scout",
      status: autoPost ? "approved" : "pending_review",
      replyTo: summonReq?.tweetId ?? null, costUsd: moment.costUsd,
    }).returning();
    await database.update(candidates).set({ status: "selected" }).where(eq(candidates.id, row.id));

    await logEvent(
      holdReason ? "error" : "scored",
      holdReason
        ? `Clip HELD by safety screen (needs your review): ${row.title} — ${holdReason}`
        : autoPost ? `Clip ready — queued to post: ${row.title}` : `Clip ready for review: ${row.title}`,
      "clips", clip.id,
    );
    collected++;
  }

  // Drain the posting queue: publish "approved" clips under the daily cap + pacing.
  const posted = await drainApprovedClips(cfg);

  if (inFlight.length || posted || expiredClips) {
    slog("collect_renders", { checked: inFlight.length, collected, posted, failed, expired: expiredClips });
  }
  return { checked: inFlight.length, collected, posted, failed, expired: expiredClips };
}

/** Publish approved clips: summon replies immediately (a human asked), scout clips paced —
 *  at most dailyClipCap per UTC day and at least MIN_CLIP_POST_GAP_MIN between posts, so the
 *  account reads curated rather than firehose. Runs on every scout (30m) and summon (5m)
 *  cycle, so held-back clips drip out on their own. No-ops without X credentials. */
export async function drainApprovedClips(cfg?: Settings): Promise<number> {
  if (!hasXEnv()) return 0;
  const database = db();
  const settings = cfg ?? (await getSettings());

  const queue = await database
    .select().from(clips)
    .where(eq(clips.status, "approved"))
    .orderBy(clips.createdAt);
  if (!queue.length) return 0;

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const postedToday = (await database
    .select({ id: clips.id, postedAt: clips.postedAt, kind: clips.kind })
    .from(clips)
    .where(and(eq(clips.status, "posted"), gte(clips.postedAt, dayStart)))
  );
  let scoutPostedToday = postedToday.filter((c) => c.kind === "scout").length;
  let lastPostedAt = postedToday.reduce<number>(
    (max, c) => Math.max(max, c.postedAt ? new Date(c.postedAt).getTime() : 0), 0,
  );

  let posted = 0;
  for (const clip of queue) {
    const isSummon = clip.kind === "summon";
    if (!isSummon) {
      if (scoutPostedToday >= settings.dailyClipCap) break; // cap reached — rest wait for tomorrow
      const gapMs = MIN_CLIP_POST_GAP_MIN * 60 * 1000;
      if (lastPostedAt && Date.now() - lastPostedAt < gapMs) break; // paced — next cycle picks it up
    }

    try {
      const res = await xPublisher().publish(
        {
          clipUrl: clip.clipUrl ?? "",
          postText: clip.postText,
          costUsd: clip.costUsd ?? 0,
          durationS: Math.max(0, Math.round((clip.endS ?? 0) - (clip.startS ?? 0))),
        },
        clip.replyTo ?? null,
      );
      await markClipPosted(clip, res.xPostId);
      lastPostedAt = Date.now();
      if (!isSummon) scoutPostedToday++;
      posted++;
    } catch (e) {
      await database.update(clips)
        .set({ status: "failed", failReason: (e as Error).message.slice(0, 500) })
        .where(eq(clips.id, clip.id));
      await logEvent("error", `Publish failed for clip #${clip.id}: ${(e as Error).message}`, "clips", clip.id);
      // Keep draining the rest — one bad clip (e.g. an expired asset URL) shouldn't block the queue.
    }
  }
  return posted;
}

/** Post-publish bookkeeping shared by the drain and the manual approve route. */
export async function markClipPosted(clip: Clip, xPostId: string | null): Promise<void> {
  const database = db();
  await database.update(clips)
    .set({ status: "posted", xPostId, postedAt: new Date(), failReason: "" })
    .where(eq(clips.id, clip.id));
  if (clip.candidateId) {
    await database.update(candidates).set({ status: "posted" }).where(eq(candidates.id, clip.candidateId));
  }
  if (clip.kind === "summon" && clip.replyTo) {
    const req = (await database
      .select().from(summonRequests)
      .where(eq(summonRequests.tweetId, clip.replyTo)).limit(1))[0];
    if (req) await database.update(summonRequests).set({ status: "replied" }).where(eq(summonRequests.id, req.id));
  }
  await logEvent(
    clip.kind === "summon" ? "replied" : "posted",
    clip.kind === "summon" ? `Summon: replied with a clip` : `Posted: ${clip.postText.slice(0, 80)}`,
    "clips", clip.id,
  );
  // Multi-platform distribution: push the same render to every enabled connected account.
  // Never throws — a cross-post failure can't undo the X post that just succeeded.
  await crossPostClip(clip);
}
