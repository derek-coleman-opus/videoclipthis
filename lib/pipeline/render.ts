// Phase B of the clip step: collect finished OpusClip renders.
//
// Scout/Summon submit a render and persist the project id on the candidate (status "rendering"),
// then move on — no request ever waits on a render. This collector runs at the top of every
// scout and summon cycle: one cheap status check per in-flight candidate; finished renders
// become clips (queued for review, auto-posted, or posted as a summon reply); stale ones fail.

import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db, candidates, clips, summonRequests, type Candidate } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { opusclipFetchClips, type OpusClipResult } from "./opusclip";
import { composePost } from "./production";
import { xPublisher } from "./publishing";
import { requireXEnv } from "./env";
import { logEvent } from "./events";
import { slog } from "./util";
import type { DetectedCandidate, Moment } from "./types";

/** Give a render this long before declaring it dead. */
const RENDER_TIMEOUT_H = Number(process.env.RENDER_TIMEOUT_H ?? 2);

/** Pending-review clips older than this are stale — the moment has passed, so expire them
 *  (we only want to post NEW content). Env-overridable. */
const CLIP_REVIEW_TTL_H = Number(process.env.CLIP_REVIEW_TTL_H ?? 6);

export interface CollectResult {
  checked: number;
  collected: number;
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

/** Check every in-flight render; turn finished ones into clips, fail stale ones. */
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
    const ageMs = Date.now() - new Date(row.detectedAt ?? row.createdAt ?? Date.now()).getTime();
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
    const durationS = Math.max(0, Math.round(moment.endS - moment.startS));

    // Summon candidates reply in-thread immediately; scout clips obey the autonomy gate.
    const summonReq = row.source === "summon"
      ? (await database.select().from(summonRequests).where(eq(summonRequests.candidateId, row.id)).limit(1))[0]
      : undefined;
    const autoPost = row.source === "summon" || cfg.autonomy === "auto";

    let xPostId: string | null = null;
    try {
      if (autoPost) {
        requireXEnv();
        const res = await xPublisher().publish(
          { clipUrl: moment.clipUrl, postText, costUsd: moment.costUsd, durationS },
          summonReq?.tweetId ?? null,
        );
        xPostId = res.xPostId;
      }
    } catch (e) {
      await database.update(candidates).set({ status: "failed" }).where(eq(candidates.id, row.id));
      await logEvent("error", `Publish failed for "${row.title}": ${(e as Error).message}`, "candidates", row.id);
      failed++;
      continue;
    }

    const [clip] = await database.insert(clips).values({
      candidateId: row.id, startS: moment.startS, endS: moment.endS,
      hookCaption: moment.hookCaption, postText, clipUrl: moment.clipUrl,
      kind: row.source === "summon" ? "summon" : "scout",
      status: autoPost ? "posted" : "pending_review",
      xPostId, replyTo: summonReq?.tweetId ?? null, costUsd: moment.costUsd,
      postedAt: autoPost ? new Date() : null,
    }).returning();

    await database.update(candidates)
      .set({ status: autoPost ? "posted" : "selected" })
      .where(eq(candidates.id, row.id));
    if (summonReq) {
      await database.update(summonRequests).set({ status: "replied" }).where(eq(summonRequests.id, summonReq.id));
    }

    if (autoPost) {
      await logEvent(
        summonReq ? "replied" : "posted",
        summonReq ? `Summon: replied to @${summonReq.requester} with a clip` : `Posted: ${row.title}`,
        "clips", clip.id,
      );
    } else {
      await logEvent("scored", `Clip ready for review: ${row.title}`, "clips", clip.id);
    }
    collected++;
  }

  if (inFlight.length || expiredClips) {
    slog("collect_renders", { checked: inFlight.length, collected, failed, expired: expiredClips });
  }
  return { checked: inFlight.length, collected, failed, expired: expiredClips };
}
