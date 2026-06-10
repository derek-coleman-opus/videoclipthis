import { eq } from "drizzle-orm";
import { db, candidates, clips, events, runs } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { DEFAULT_THRESHOLD, COST_CAP_USD, MAX_CLIPS_PER_RUN } from "./config";
import { requireScoutEnv, requireXEnv } from "./env";
import { slog } from "./util";
import { buildSources } from "./sources";
import { claudeScorer } from "./scoring";
import { opusclipSelector } from "./selection";
import { opusclipClipper, needsCreditResolution } from "./production";
import { xPublisher } from "./publishing";
import { matchFigure } from "./figures";
import { reshareBoost } from "./feedback";
import { getFigures } from "@/lib/figures-store";

export interface ScoutResult {
  runId: number;
  found: number;
  posted: number;
  queued: number;
  skipped: number;
  paused?: boolean;
}

/** Append a row to the activity feed. */
export async function logEvent(
  type: string, message: string, refTable?: string, refId?: number,
): Promise<void> {
  await db().insert(events).values({
    type, message, refTable: refTable ?? null, refId: refId ?? null,
  });
}

/**
 * The Scout pipeline: ingest -> score (gate) -> credit-check -> select -> produce -> publish,
 * persisting every step. Auto-publishes to X only when autonomy === "auto"; otherwise clips
 * are queued for review (pending_review) and shown in the admin. No mock fallback — a run
 * aborts up front if the required external-service keys are missing.
 */
export async function runScout(opts?: { force?: boolean }): Promise<ScoutResult> {
  requireScoutEnv();
  const cfg = await getSettings();
  const database = db();

  const [run] = await database.insert(runs).values({ kind: "scout" }).returning();

  if (cfg.paused && !opts?.force) {
    await database.update(runs)
      .set({ finishedAt: new Date(), errors: "paused" })
      .where(eq(runs.id, run.id));
    await logEvent("run", "Scout skipped — paused");
    return { runId: run.id, found: 0, posted: 0, queued: 0, skipped: 0, paused: true };
  }

  const autoPost = cfg.autonomy === "auto";
  if (autoPost) requireXEnv();

  const figures = await getFigures();
  const sources = buildSources(figures);
  const scorer = claudeScorer(process.env.ANTHROPIC_API_KEY ?? "");
  const selector = opusclipSelector(process.env.OPUSCLIP_API_KEY ?? "", process.env.ANTHROPIC_API_KEY ?? "");
  const clipper = opusclipClipper(process.env.OPUSCLIP_API_KEY ?? "", process.env.OPUSCLIP_API_BASE ?? "");
  const publisher = autoPost ? xPublisher() : null;
  const threshold = cfg.threshold ?? DEFAULT_THRESHOLD;
  slog("scout_start", { threshold, autoPost });

  let found = 0, posted = 0, queued = 0, skipped = 0;
  let costSpent = 0;
  let capped = false;

  for (const src of sources) {
    let detected;
    try {
      detected = await src.discover();
    } catch (e) {
      await logEvent("error", `${src.name} discover failed: ${(e as Error).message}`);
      continue;
    }

    for (const d of detected) {
      found++;

      // Track key AI figures: if a tracked figure is the speaker, resolve their @ so we can
      // always credit + tag them (turns an un-attributed talk into a creditable clip).
      const fig = matchFigure(figures, d);
      if (fig) {
        d.figureName = fig.name;
        if (!d.speakerHandle) d.speakerHandle = fig.xHandle;
      }

      // Dedup — never reprocess a video we've already seen.
      const existing = await database
        .select({ id: candidates.id })
        .from(candidates)
        .where(eq(candidates.videoId, d.videoId))
        .limit(1);
      if (existing.length) { skipped++; continue; }

      const [cand] = await database.insert(candidates).values({
        source: d.source, url: d.url, videoId: d.videoId, title: d.title,
        speaker: d.speaker ?? "", speakerHandle: d.speakerHandle ?? "",
        channel: d.channel ?? "", event: d.event ?? "",
        durationS: d.durationS ?? 0, signalStrength: d.signalStrength ?? 0,
        figureName: d.figureName ?? null,
        status: "found",
      }).returning();
      await logEvent("found", `Found: ${d.title} (${src.name})${fig ? ` · 🎯 ${fig.name}` : ""}`, "candidates", cand.id);

      try {
      const scored = await scorer.score(d);
      // Feed performance back into ranking: proven speakers (prior reshares) get a score boost.
      const boost = await reshareBoost(d.speakerHandle);
      const score = Math.min(100, scored.score + boost);
      const rationale = boost ? `${scored.rationale} (+${boost} prior-reshare)` : scored.rationale;
      await database.update(candidates)
        .set({ score, rationale, status: "scored" })
        .where(eq(candidates.id, cand.id));

      // Precision gate.
      if (score < threshold) {
        await database.update(candidates).set({ status: "skipped" }).where(eq(candidates.id, cand.id));
        await logEvent("skipped", `Skipped [${score}]: ${d.title}`, "candidates", cand.id);
        skipped++; continue;
      }
      // Credit-first rule — never post what we can't attribute.
      if (needsCreditResolution(d)) {
        await database.update(candidates).set({ status: "held" }).where(eq(candidates.id, cand.id));
        await logEvent("held", `Held [${score}] — no speaker credit: ${d.title}`, "candidates", cand.id);
        skipped++; continue;
      }

      const moment = await selector.select(d);
      if (!moment) { skipped++; continue; }

      // Hardening: per-run cost + volume caps.
      if (costSpent >= COST_CAP_USD || posted + queued >= MAX_CLIPS_PER_RUN) {
        await logEvent("run", `Cap reached ($${costSpent.toFixed(2)} / ${posted + queued} clips) — stopping run early.`);
        capped = true;
        break;
      }

      const produced = await clipper.produce(d, moment);
      costSpent += produced.costUsd ?? 0;
      const result = autoPost && publisher ? await publisher.publish(produced) : { xPostId: null };

      const [clip] = await database.insert(clips).values({
        candidateId: cand.id, startS: moment.startS, endS: moment.endS,
        hookCaption: moment.hookCaption, postText: produced.postText, clipUrl: produced.clipUrl,
        kind: "scout", status: autoPost ? "posted" : "pending_review",
        xPostId: result.xPostId, costUsd: produced.costUsd,
        postedAt: autoPost ? new Date() : null,
      }).returning();

      await database.update(candidates)
        .set({ status: autoPost ? "posted" : "selected" })
        .where(eq(candidates.id, cand.id));

      if (autoPost) {
        posted++;
        await logEvent("posted", `Posted: ${d.title}`, "clips", clip.id);
      } else {
        queued++;
        await logEvent("scored", `Queued for review [${score}]: ${d.title}`, "clips", clip.id);
      }
      } catch (e) {
        await database.update(candidates).set({ status: "failed" }).where(eq(candidates.id, cand.id));
        await logEvent("error", `Failed on "${d.title}": ${(e as Error).message}`, "candidates", cand.id);
      }
    }
    if (capped) break;
  }

  await database.update(runs)
    .set({ finishedAt: new Date(), found, posted, skipped })
    .where(eq(runs.id, run.id));
  await logEvent("run",
    `Scout done — found ${found}, posted ${posted}, queued ${queued}, skipped ${skipped}`);

  slog("scout_done", { found, posted, queued, skipped, costSpent: Number(costSpent.toFixed(2)) });
  return { runId: run.id, found, posted, queued, skipped };
}
