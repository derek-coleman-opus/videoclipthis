// Phase B of the clip step: collect finished OpusClip renders, then drain the posting queue.
//
// Scout/Summon submit a render and persist the project id on the candidate (status "rendering"),
// then move on — no request ever waits on a render. This collector runs at the top of every
// scout and summon cycle: one cheap status check per in-flight candidate. Finished renders become
// clip ROWS FIRST (so a publish failure can never lose a paid render), and publishing happens in
// a separate drain step that paces auto-posts (daily cap + minimum gap) so the account never
// bursts. Summon replies skip the cap/pacing — a human asked.
//
// Between "render finished" and "clip row" sits the EDITOR (./editorial.ts): it compares the
// project's renders, picks the best, writes the pull quote, and vetoes clips too boring to post.
// A vetoed clip is queued for review, never deleted — the render is already paid for.

import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db, candidates, clips, summonRequests, type Candidate, type Clip, type Settings } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { findProfile } from "./audience";
import { MIN_CLIP_POST_GAP_MIN } from "./config";
import { opusclipExportClip, opusclipFetchClips, type OpusClipResult } from "./opusclip";
import { freshClipUrl } from "./clipFile";
import { crossPostClip } from "./crosspost";
import { screenClipForAutoPost } from "./clipSafety";
import {
  EDITORIAL_MAX_OPTIONS, EDITORIAL_MIN_SCORE, editorialPasses, reviewClips,
} from "./editorial";
import { topPullQuotes } from "./feedback";
import { composePost, composeSummonReply, followUpText } from "./production";
import { publishProvablyNotPosted, xPublisher } from "./publishing";
import { hasXEnv, missingXEnv } from "./env";
import { logEvent } from "./events";
import { slog } from "./util";
import type { DetectedCandidate, Moment } from "./types";

/** Give a render this long AFTER SUBMISSION before declaring it dead.
 *
 *  Covers TWO stages, which is why it is no longer 2h: OpusClip renders the clips, and then the
 *  clip the editor picks is exported on demand (see opusclipExportClip). An export that is still
 *  rendering defers the candidate to the next collect cycle, up to 30 minutes later, so a budget
 *  sized for the first stage alone could expire a candidate that was progressing normally. */
const RENDER_TIMEOUT_H = Number(process.env.RENDER_TIMEOUT_H ?? 4);

/** How long a "collecting" claim may be held before it is assumed stranded and released.
 *  A real collect takes seconds (one OpusClip check + one editor call); this is far above that and
 *  far below RENDER_TIMEOUT_H, so a function killed mid-collect gets retried instead of silently
 *  dropping a paid render, and a genuinely in-flight collect is never stolen from. */
const COLLECT_CLAIM_TTL_MIN = Number(process.env.COLLECT_CLAIM_TTL_MIN ?? 15);

/** Pending-review clips older than this are stale — the moment has passed, so expire them
 *  (we only want to post NEW content). Env-overridable. */
export const CLIP_REVIEW_TTL_H = Number(process.env.CLIP_REVIEW_TTL_H ?? 6);

/** Clip states that must STOP a candidate producing another clip.
 *
 *  Read it as "a post exists, might exist, or was deliberately killed":
 *    posted/posting  — it is live, or a publish is in flight
 *    unverified      — the outcome is unknown; a second clip is exactly the double-post we avoid
 *    rejected        — a human said no, and a re-collect must not overrule them
 *    pending_review/approved — a live clip is already queued for this candidate
 *
 *  Deliberately ABSENT: `expired` and `failed`. Both mean a paid render produced nothing posted
 *  and nobody chose to kill it, so both must be able to try again. */
const CLIP_BLOCKS_RECOLLECT = [
  "pending_review", "approved", "posting", "posted", "unverified", "rejected",
];

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
    channelXHandle: row.channelXHandle ?? "",
    event: row.event ?? "",
    durationS: row.durationS ?? 0,
    figureName: row.figureName ?? undefined,
  };
}

/** `url` is passed in rather than read off the clip because the clip carries TWO urls with very
 *  different lifetimes (a durable export and a short-lived preview) and the choice between them is
 *  the caller's, made explicitly and logged. Burying it in here is how the wrong one gets persisted. */
function toMoment(best: OpusClipResult, url: string): Moment {
  return {
    startS: best.startS,
    endS: best.endS,
    hookCaption: best.caption || "the moment worth watching",
    confidence: Math.min(1, best.score / 100),
    clipUrl: url,
    costUsd: best.costUsd,
  };
}

/** Check every in-flight render; finished ones become clip rows; stale ones fail.
 *  Then drain the posting queue (paced). */
export async function collectRenders(): Promise<CollectResult> {
  const database = db();
  const cfg = await getSettings();
  const profile = findProfile(cfg.activeProfile);
  // Per-profile shareability floor: the right bar differs by lane, and one floor for both starves
  // whichever lane it was not tuned for. An explicit EDITORIAL_MIN_SCORE env still wins.
  const minScore = process.env.EDITORIAL_MIN_SCORE ? EDITORIAL_MIN_SCORE : profile.editorialMinScore;
  const apiKey = process.env.OPUSCLIP_API_KEY ?? "";
  const base = process.env.OPUSCLIP_API_BASE ?? "";

  // Release claims stranded by a killed function (serverless timeout, deploy mid-run). Without
  // this a "collecting" row is in no query at all and its paid render is lost forever.
  const staleClaim = new Date(Date.now() - COLLECT_CLAIM_TTL_MIN * 60 * 1000);
  const released = await database.update(candidates)
    .set({ status: "rendering" })
    // A NULL render_started_at counts as stale: it cannot be a fresh claim (the timestamp is set at
    // submit), and excluding NULLs would strand exactly the rows nothing else can reach.
    .where(and(
      eq(candidates.status, "collecting"),
      or(lt(candidates.renderStartedAt, staleClaim), isNull(candidates.renderStartedAt)),
    ))
    .returning({ id: candidates.id });
  if (released.length) {
    slog("collect_claims_released", { n: released.length });
  }

  // Same hazard on the posting side: a clip claimed into "posting" whose function was killed
  // mid-publish is in no query — not drained, not reported, never resolved. It becomes
  // "unverified" rather than going back to "approved", because the publish may well have reached
  // X; re-queueing it for the drain is precisely the double-post this claim exists to prevent.
  const stalePosting = await database.update(clips)
    .set({
      status: "unverified",
      failReason: "AMBIGUOUS — the publish was interrupted and its outcome is unknown. Check the "
        + "timeline before retrying: this clip may already be live on X.",
    })
    .where(and(eq(clips.status, "posting"), lt(clips.createdAt, staleClaim)))
    .returning({ id: clips.id });
  if (stalePosting.length) {
    await logEvent("error",
      `${stalePosting.length} clip(s) were left mid-publish and their outcome is unknown — check `
      + `the timeline before retrying them from /posts`);
  }

  const inFlight = await database
    .select()
    .from(candidates)
    .where(and(eq(candidates.status, "rendering"), isNotNull(candidates.opusProjectId)));

  // Expire stale review-queue clips first (only post NEW content).
  const expiredClips = await expireStaleClips();

  let collected = 0;
  let failed = 0;
  // Why a cycle produced nothing. Every one of these paths used to `continue` with no logEvent and
  // no slog, so a candidate could loop here every 30 minutes for the full RENDER_TIMEOUT_H window
  // emitting absolutely nothing, then mark itself failed. Three weeks of "why is it not posting?"
  // came down to this silence. Counted here and reported ONCE per cycle below — per-candidate
  // logging would flood the very feed that has to stay readable.
  let stillRendering = 0;
  let oldestWaitMs = 0;
  const checkErrors: string[] = [];

  for (const row of inFlight) {
    // CLAIM IT FIRST, for the same reason the posting drain does: scout and summon are both on
    // */30 and both call this, so two runs could pick up the same "rendering" candidate, both run
    // the editor, and both insert a clip row for it — two clips for one video, each of which then
    // posts. The compare-and-swap is atomic, so exactly one run proceeds.
    const claimed = await database.update(candidates)
      .set({ status: "collecting" })
      .where(and(eq(candidates.id, row.id), eq(candidates.status, "rendering")))
      .returning({ id: candidates.id });
    if (!claimed.length) continue; // another run has it

    // Timeout clock starts at SUBMISSION, not detection — a candidate can legitimately wait
    // hours as "scored" for a free render slot before it is ever submitted.
    const startedAt = row.renderStartedAt ?? row.detectedAt ?? row.createdAt ?? new Date();
    const ageMs = Date.now() - new Date(startedAt).getTime();
    const expired = ageMs > RENDER_TIMEOUT_H * 3600 * 1000;

    // ONE BAD CANDIDATE MUST NOT KILL THE RUN. Everything below — the editor call, the safety
    // screen, post composition, the clip insert, cross-posting — was unguarded, so a single throw
    // escaped this loop, and because runScout awaits collectRenders() before it discovers or
    // submits anything, the WHOLE pipeline stopped. Not hypothetical: renders ran hourly and then
    // ceased entirely, while this loop kept re-fetching the first few projects every cycle and
    // dying at the same row.
    try {

      let clipsReady: OpusClipResult[] = [];
      let done = false;
      // How many clips the project actually returned, before the URL filter. A project that
      // returns clips none of which carry a URL is an INTEGRATION failure, not a slow render, and
      // the two were indistinguishable in the log below.
      let returnedClips = 0;
      try {
        const res = await opusclipFetchClips(row.opusProjectId as string, apiKey, base);
        returnedClips = res.clips.length;
        // "Ready to judge" is a FINISHED RENDER, which means a preview exists — the export has not
        // been requested yet at this point and never appears on its own. Filtering on clipUrl here
        // (export-only) left clipsReady permanently empty, which is the outage.
        clipsReady = res.clips
          .filter((c) => (c.clipUrl || c.previewUrl) && !c.renderPending)
          .sort((a, b) => b.score - a.score);
        done = res.done;
      } catch (e) {
        // Transient check failure: leave it rendering unless it's already stale. Releasing the claim
        // matters — a row left "collecting" is in no query and would never be retried.
        if (!expired) {
          await database.update(candidates).set({ status: "rendering" }).where(eq(candidates.id, row.id));
          checkErrors.push(`"${row.title}": ${(e as Error).message}`);
          continue;
        }
        await database.update(candidates).set({ status: "failed" }).where(eq(candidates.id, row.id));
        await logEvent("error", `Render check failed for "${row.title}": ${(e as Error).message}`, "candidates", row.id);
        failed++;
        continue;
      }

      // Still rendering: take a partial result once it's stale, otherwise keep waiting.
      if (!done && !(expired && clipsReady.length)) {
        if (expired) {
          await database.update(candidates).set({ status: "failed" }).where(eq(candidates.id, row.id));
          // "Timed out" was a lie whenever the project HAD clips: OpusClip had finished, and the
          // only thing missing was a URL this client knew how to read. Say which it is, because
          // one is a slow render and the other is a contract mismatch that will repeat on every
          // candidate forever.
          await logEvent("error",
            returnedClips > 0
              ? `OpusClip returned ${returnedClips} clip(s) for "${row.title}" but NONE carried a `
                + `usable video URL, so nothing could be collected — this is an API contract `
                + `mismatch, not a slow render, and it will repeat on every candidate until the `
                + `field this client reads matches what the API sends. Inspect the raw response at `
                + `/api/debug/opusclip?projectId=${row.opusProjectId}.`
              : `Render timed out (no clips after ${RENDER_TIMEOUT_H}h): ${row.title}`,
            "candidates", row.id);
          failed++;
        } else {
          // Release the claim so the next run picks it up again.
          await database.update(candidates).set({ status: "rendering" }).where(eq(candidates.id, row.id));
          stillRendering++;
          oldestWaitMs = Math.max(oldestWaitMs, ageMs);
        }
        continue;
      }

      // THE EDITOR. One Claude call compares the top renders, picks the best, scores its
      // shareability, and writes the verbatim pull quote used as the hook. We pay OpusClip per
      // minute of SOURCE video, so every clip in the project is already bought — judging three
      // instead of blindly taking clipsReady[0] costs one prompt and rescues the cases where the
      // highest retention score is the least interesting thing said.
      const verdict = await reviewClips({
        title: row.title,
        speaker: row.speaker ?? undefined,
        channel: row.channel ?? undefined,
        transcript: row.transcript ?? undefined,
        niche: cfg.niche ?? "",
        // Clip-level rubric from the active profile, so the editor's bar matches the lane the
        // scorer and curator were working in rather than always judging for developers.
        editorialRubric: profile.editorialRubric,
        editorialFloor: profile.editorialFloor,
        guardrails: profile.guardrails,
        winners: await topPullQuotes(),
        options: clipsReady.slice(0, EDITORIAL_MAX_OPTIONS).map((c) => ({
          caption: c.caption,
          durationS: Math.max(0, c.endS - c.startS),
          hookScore: c.score,
        })),
      });
      const chosen = clipsReady[verdict?.pick ?? 0] ?? clipsReady[0];

      // EXPORT THE ONE CLIP WE ARE ABOUT TO POST. Clips are preview-only until exported, and the
      // preview's signed URL dies in ~59h — fine for an immediate upload to X, fatal for
      // clips.clipUrl, which the public /clips, /clips/[id], /speakers/[slug] and /posts pages
      // replay as a <video src> indefinitely. Exporting here rather than in the fetch loop means
      // one export per POSTED clip instead of one per clip in the project.
      let clipUrl = chosen.clipUrl;
      let urlNote = "";
      if (!clipUrl) {
        const exported = await opusclipExportClip(row.opusProjectId as string, chosen.clipId, apiKey, base);
        if (exported.status === "ready" && exported.url) {
          clipUrl = exported.url;
        } else if (exported.status === "rendering") {
          // Not a failure — the export was started and needs a moment. Put the candidate back and
          // let the next cycle pick it up; nothing is lost and nothing ephemeral gets persisted.
          //
          // `expired` is checked here for the same reason every other release path checks it: a
          // release that ignores the timeout clock makes the candidate IMMORTAL. It would come
          // back every cycle forever, and — because "rendering" counts against
          // MAX_CONCURRENT_RENDERS — permanently eat one of the three submit slots. Three exports
          // that never reach "ready" would wedge the whole pipeline with no way out.
          if (expired) {
            await database.update(candidates).set({ status: "failed" }).where(eq(candidates.id, row.id));
            await logEvent("error",
              `Export for "${row.title}" never became ready within ${RENDER_TIMEOUT_H}h. The render `
              + `is paid for and still exists — re-collect it from the dashboard once the export `
              + `clears.`, "candidates", row.id);
            failed++;
            continue;
          }
          await database.update(candidates).set({ status: "rendering" }).where(eq(candidates.id, row.id));
          await logEvent("run",
            `Export started for "${row.title}" — collecting it on the next cycle.`,
            "candidates", row.id);
          continue;
        } else {
          // Export unavailable: post the preview rather than drop a paid render on the floor, but
          // say so, because the stored URL will stop playing on the public pages within a day.
          urlNote = exported.detail;
          clipUrl = chosen.previewUrl;
        }
      }
      if (!clipUrl) {
        // Same immortality hazard as above: without the expiry check this candidate is retried
        // forever while holding a concurrency slot.
        await database.update(candidates)
          .set({ status: expired ? "failed" : "rendering" })
          .where(eq(candidates.id, row.id));
        if (expired) failed++;
        await logEvent("error",
          `No usable video URL for "${row.title}" — neither an export nor a preview`
          + `${expired ? ` after ${RENDER_TIMEOUT_H}h, giving up` : ", will retry"}. `
          + `${urlNote || "Inspect the raw response at /api/debug/opusclip?projectId=" + row.opusProjectId}`,
          "candidates", row.id);
        continue;
      }
      if (urlNote) {
        await logEvent("error",
          `Posting "${row.title}" from a SHORT-LIVED preview URL because the export was `
          + `unavailable (${urlNote}). The post will be fine; the clip on the public pages will `
          + `stop playing within about two days. Confirm the export endpoint at `
          + `/api/debug/opusclip?projectId=${row.opusProjectId}.`,
          "candidates", row.id);
      }
      const moment = toMoment(chosen, clipUrl);
      const d = toDetected(row);
      // Summon clips are in-thread comments (credit the video author, no link back);
      // scout clips are standalone credit-first posts with the source link in a follow-up.
      const isSummonRow = row.source === "summon";
      const postText = isSummonRow
        ? composeSummonReply(d, moment, verdict)
        : composePost(d, moment, verdict);
      const followUp = isSummonRow ? "" : followUpText(d);

      // Summon candidates reply in-thread (always auto); scout clips obey the autonomy gate.
      const summonReq = isSummonRow
        ? (await database.select().from(summonRequests).where(eq(summonRequests.candidateId, row.id)).limit(1))[0]
        : undefined;
      let autoPost = isSummonRow || cfg.autonomy === "auto";

      // The editorial veto: a clip the editor judged unshareable is never posted unattended. It
      // lands in the review queue rather than being discarded — the render is paid for and the
      // operator may disagree with the editor. Summon replies are exempt: a human asked for that
      // specific video, and "nothing here was interesting enough" is not an acceptable answer to a
      // direct request.
      let vetoNote = "";
      // A forced candidate is exempt for the same reason summon is: the operator overrode the score
      // gate on this specific video, so "the editor didn't like it either" would just move the veto
      // one step later and waste the render they deliberately paid for.
      if (autoPost && !isSummonRow && !row.forced && !editorialPasses(verdict, minScore)) {
        autoPost = false;
        vetoNote = `editor scored it ${verdict?.score}/${minScore} — ${verdict?.note || "not shareable enough"}`;
      }

      // Unattended posts get a final content screen (adult/violent/hate/harassment → held for a
      // human). Manual review-mode clips skip it — the human approval IS the screen.
      let holdReason = "";
      if (autoPost) {
        const screen = await screenClipForAutoPost(row.title, moment.hookCaption, postText, profile.guardrails);
        if (!screen.allow) {
          autoPost = false;
          holdReason = screen.reason;
        }
      }

      // One LIVE clip per candidate. The claim above makes a concurrent duplicate very unlikely, and
      // the partial unique index makes it impossible; this check turns what would be a constraint
      // violation into a clean skip, and also covers a candidate re-entering the loop after a
      // crash between the insert and the status update.
      //
      // The status predicate matters: without it, ANY existing clip row blocked a replacement
      // forever, including a clip that had been expired by the review TTL or had failed to publish
      // on a dead URL. The candidate was then set to "selected" and the paid render was gone for
      // good. Only states where a post exists, may exist, or was deliberately killed block a
      // retry — `expired` and `failed` are precisely the cases a re-collect is meant to rescue.
      const already = await database
        .select({ id: clips.id }).from(clips)
        .where(and(
          eq(clips.candidateId, row.id),
          inArray(clips.status, CLIP_BLOCKS_RECOLLECT),
        )).limit(1);
      if (already.length) {
        await database.update(candidates).set({ status: "selected" }).where(eq(candidates.id, row.id));
        slog("collect_skip_duplicate", { candidateId: row.id, existingClipId: already[0].id });
        continue;
      }

      // Insert the clip row BEFORE any publish attempt — the paid render is never lost to a
      // publish failure, and there is no orphan-tweet window.
      const [clip] = await database.insert(clips).values({
        candidateId: row.id, startS: moment.startS, endS: moment.endS,
        hookCaption: moment.hookCaption, postText, followUpText: followUp,
        pullQuote: verdict?.pullQuote ?? "",
        editorialScore: verdict?.score ?? null,
        editorialNote: vetoNote || verdict?.note || "",
        clipUrl: moment.clipUrl,
        opusClipId: chosen.clipId || null,
        kind: isSummonRow ? "summon" : "scout",
        status: autoPost ? "approved" : "pending_review",
        replyTo: summonReq?.tweetId ?? null, costUsd: moment.costUsd,
      }).returning();
      await database.update(candidates).set({ status: "selected" }).where(eq(candidates.id, row.id));

      const picked = clipsReady.length > 1 ? ` (best of ${Math.min(clipsReady.length, EDITORIAL_MAX_OPTIONS)})` : "";
      await logEvent(
        holdReason || vetoNote ? "held" : "scored",
        holdReason
          ? `Clip HELD by safety screen (needs your review): ${row.title} — ${holdReason}`
          : vetoNote
            ? `Clip VETOED by the editor (in review, yours to override): ${row.title} — ${vetoNote}`
            : autoPost
              ? `Clip ready — queued to post${picked}${verdict ? ` [editor ${verdict.score}]` : ""}: ${row.title}`
              : `Clip ready for review${picked}: ${row.title}`,
        "clips", clip.id,
      );
      collected++;
  
    } catch (e) {
      // Release the claim so the row is retried rather than stranded in "collecting", where no
      // query would ever see it again. An expired one is terminal; the render is already lost.
      await database.update(candidates)
        .set({ status: expired ? "failed" : "rendering" })
        .where(eq(candidates.id, row.id));
      if (expired) failed++;
      await logEvent("error",
        `Collect failed for "${row.title}"${expired ? " (expired — giving up)" : " (will retry)"}: `
        + `${(e as Error).message}`,
        "candidates", row.id);
    }
}

  // ONE line per cycle saying why nothing came out, when nothing came out. The individual paths
  // above deliberately stay quiet (they repeat every 30 min per candidate); this is the aggregate
  // that makes a stall visible on the dashboard the same day instead of never.
  if (checkErrors.length) {
    await logEvent("error",
      `OpusClip status check failed for ${checkErrors.length} in-flight render(s) — still retrying, `
      + `but they will be marked failed after ${RENDER_TIMEOUT_H}h if this does not clear. `
      + `First: ${checkErrors[0]}`);
  }
  if (stillRendering && !collected) {
    const oldestH = (oldestWaitMs / 3600_000).toFixed(1);
    const nearTimeout = oldestWaitMs > RENDER_TIMEOUT_H * 3600_000 * 0.5;
    await logEvent(nearTimeout ? "error" : "run",
      `${stillRendering} render(s) still in flight and none ready to collect — oldest has been `
      + `waiting ${oldestH}h of its ${RENDER_TIMEOUT_H}h budget.`
      + (nearTimeout
        ? ` That is over halfway, which usually means the clips ARE finished and this client cannot `
          + `read the URL field. Check the raw response at /api/debug/opusclip?projectId=…`
        : ""));
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
  const database = db();
  // NO CREDENTIALS WAS A SILENT ZERO. Every cycle returned 0 and logged nothing, so a missing or
  // expired X key looked exactly like an empty queue — the pipeline rendered, approved and queued
  // clips indefinitely while the one fact that explained it was never written down anywhere.
  // Reported only when something is actually waiting, so an idle pipeline stays quiet.
  if (!hasXEnv()) {
    const waiting = Number((await database.select({ n: sql<number>`count(*)::int` })
      .from(clips).where(eq(clips.status, "approved")))[0]?.n ?? 0);
    if (waiting > 0) {
      await logEvent("error",
        `Posting is disabled — X credentials are missing or incomplete (${missingXEnv().join(", ")}), `
        + `so ${waiting} approved clip(s) cannot publish. Nothing is wrong with the clips; set the `
        + `variables in Vercel and they drain on the next cycle.`);
    }
    return 0;
  }
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
  // Both gates used to be a silent `break`. A queue that was full but completely stationary looked
  // identical to an empty one from outside — no event, no slog, nothing on the dashboard.
  let capHeld = 0;
  let paceHeld = 0;
  for (const clip of queue) {
    // CLAIM IT FIRST. The scout and summon crons are both on */30 and both call this, and a manual
    // "Run Scout now" can overlap either — so a plain select-then-publish let two runs pick up the
    // same approved clip and post it twice. This compare-and-swap is atomic: exactly one caller
    // gets the row, everyone else sees zero rows and moves on.
    // GATES FIRST, THEN CLAIM. These were the other way round, and the cost was severe: the clip
    // was flipped to "posting", the cap or pacing check then hit `break`, and the claim was never
    // released. Nothing selects "posting", so the clip was stranded — and the stale-claim sweep
    // above later moved it to "unverified" with "the publish was interrupted and its outcome is
    // unknown", telling the operator to check the timeline for a post that was never attempted.
    // One clip per cycle went quietly into that dead end instead of waiting its turn.
    // A claim is only worth taking for a clip actually about to publish.
    // `continue`, NOT `break`. The queue is ordered by createdAt and mixes scout and summon clips,
    // so a `break` on a scout clip that hit the cap also abandoned every summon clip behind it —
    // silently defeating the exemption this very branch exists to grant ("a human asked"). Skipping
    // the one clip that is gated lets the rest of the queue through.
    const isSummon = clip.kind === "summon";
    if (!isSummon) {
      if (scoutPostedToday >= settings.dailyClipCap) {
        capHeld++;
        continue; // cap reached — this one waits for tomorrow
      }
      const gapMs = MIN_CLIP_POST_GAP_MIN * 60 * 1000;
      if (lastPostedAt && Date.now() - lastPostedAt < gapMs) {
        paceHeld++;
        continue; // paced — next cycle picks it up
      }
    }

    const claimed = await database.update(clips)
      .set({ status: "posting" })
      .where(and(eq(clips.id, clip.id), eq(clips.status, "approved")))
      .returning({ id: clips.id });
    if (!claimed.length) continue; // another run already has it

    try {
      // RE-MINT BEFORE PUBLISHING. clip.clipUrl was signed at collect time and expires in about a
      // day, while this drain deliberately holds clips: behind the daily cap they wait for
      // tomorrow, and behind the pacing gap they wait a cycle. A clip queued on Monday and
      // released on Wednesday published a dead URL and failed permanently — the cap turning
      // healthy clips into failures. Re-exporting is free and idempotent.
      const fresh = await freshClipUrl(clip.id);
      const res = await xPublisher().publish(
        {
          clipUrl: fresh ?? clip.clipUrl ?? "",
          postText: clip.postText,
          costUsd: clip.costUsd ?? 0,
          durationS: Math.max(0, Math.round((clip.endS ?? 0) - (clip.startS ?? 0))),
          followUpText: clip.followUpText ?? "",
        },
        clip.replyTo ?? null,
      );
      await markClipPosted(clip, res.xPostId);
      lastPostedAt = Date.now();
      if (!isSummon) scoutPostedToday++;
      posted++;
    } catch (e) {
      const msg = (e as Error).message;
      // A publish that PROVABLY did not post is safe to retry; an ambiguous one is not. The tweet
      // call is non-idempotent, so if X accepted the post and the response was lost, marking this
      // "failed" offers the operator a one-click retry that posts the same video again — which is
      // how the same clip went out several times. "unverified" keeps it out of the automatic
      // drain and tells the operator to check the timeline before deciding.
      const safeToRetry = publishProvablyNotPosted(e);
      await database.update(clips)
        .set({
          status: safeToRetry ? "failed" : "unverified",
          failReason: (safeToRetry
            ? msg
            : `AMBIGUOUS — X may already have this post. Check the timeline before retrying: ${msg}`
          ).slice(0, 500),
        })
        .where(eq(clips.id, clip.id));
      await logEvent("error",
        safeToRetry
          ? `Publish failed for clip #${clip.id} (not posted, safe to retry): ${msg}`
          : `Publish OUTCOME UNKNOWN for clip #${clip.id} — it may be live on X. Check before retrying: ${msg}`,
        "clips", clip.id);
      // Keep draining the rest — one bad clip (e.g. an expired asset URL) shouldn't block the queue.
    }
  }

  // Say so when the queue is full but held. "Nothing posted" and "nothing to post" are completely
  // different problems and they used to look identical from the outside.
  if (!posted && (capHeld || paceHeld)) {
    await logEvent("run",
      capHeld
        ? `${capHeld} clip(s) ready but held: today's cap of ${settings.dailyClipCap} scout post(s) `
          + `is used up. They post tomorrow — raise dailyClipCap in Settings to let more through.`
        : `${paceHeld} clip(s) ready but held: the minimum ${MIN_CLIP_POST_GAP_MIN}-minute gap `
          + `between posts has not elapsed. The next cycle will post one.`);
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
