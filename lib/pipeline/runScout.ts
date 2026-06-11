import { eq } from "drizzle-orm";
import { db, candidates, runs } from "@/lib/db";
import { getSettings, updateSummonState } from "@/lib/settings";
import { DEFAULT_THRESHOLD, MAX_CLIPS_PER_RUN, FIGURE_SEARCH_INTERVAL_H } from "./config";
import { requireScoutEnv } from "./env";
import { slog } from "./util";
import { buildSources } from "./sources";
import { claudeScorer } from "./scoring";
import { opusclipCreateProject } from "./opusclip";
import { needsCreditResolution } from "./production";
import { collectRenders } from "./render";
import { matchFigure } from "./figures";
import { reshareBoost } from "./feedback";
import { logEvent } from "./events";
import { getFigures } from "@/lib/figures-store";

export { logEvent } from "./events";

export interface ScoutResult {
  runId: number;
  found: number;
  rendering: number;
  collected: number;
  skipped: number;
  paused?: boolean;
}

/**
 * The Scout pipeline, two-phase so no request ever waits on a render:
 *   Phase B (first): collectRenders() — finished OpusClip renders become clips
 *     (pending_review, auto-posted, or summon replies).
 *   Phase A: ingest -> score (gate) -> credit-check -> SUBMIT render (status "rendering").
 * Persists every step. No mock fallback — a run aborts up front if required keys are missing.
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
    return { runId: run.id, found: 0, rendering: 0, collected: 0, skipped: 0, paused: true };
  }

  // Phase B first: collect any renders that finished since the last run (clips queue/post here).
  const collect = await collectRenders();

  const figures = await getFigures();
  // Figure searches cost 100 YouTube quota units each — only run them every few hours.
  const figureSearchDue =
    !cfg.figureSearchAt ||
    Date.now() - new Date(cfg.figureSearchAt).getTime() >= FIGURE_SEARCH_INTERVAL_H * 3600 * 1000;
  const sources = buildSources(figures, { figureSearch: figureSearchDue });
  if (figureSearchDue) await updateSummonState({ figureSearchAt: new Date() });
  const scorer = claudeScorer(process.env.ANTHROPIC_API_KEY ?? "");
  const opusKey = process.env.OPUSCLIP_API_KEY ?? "";
  const opusBase = process.env.OPUSCLIP_API_BASE ?? "";
  const threshold = cfg.threshold ?? DEFAULT_THRESHOLD;
  slog("scout_start", { threshold, collected: collect.collected });

  let found = 0, rendering = 0, skipped = 0;
  let capped = false;

  for (const src of sources) {
    let detected;
    try {
      detected = await src.discover();
    } catch (e) {
      await logEvent("error", `${src.name} discover failed: ${(e as Error).message}`);
      continue;
    }
    if (detected.length === 0) {
      // Per-channel/search failures are swallowed inside discover(), so an empty result can
      // hide quota exhaustion — surface it where the operator will see it.
      await logEvent("error",
        `${src.name}: discovery returned 0 videos — possible YouTube quota exhaustion (check Vercel logs for "quotaExceeded")`);
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

      // Volume cap on new render submissions per run.
      if (rendering >= MAX_CLIPS_PER_RUN) {
        await logEvent("run", `Cap reached (${rendering} renders submitted) — stopping run early.`);
        capped = true;
        break;
      }

      // Submit the render and move on — collectRenders() picks it up on a later run.
      const projectId = await opusclipCreateProject(d.url, opusKey, opusBase);
      await database.update(candidates)
        .set({ status: "rendering", opusProjectId: projectId })
        .where(eq(candidates.id, cand.id));
      rendering++;
      await logEvent("rendering", `Rendering [${score}]: ${d.title} (OpusClip ${projectId})`, "candidates", cand.id);
      } catch (e) {
        await database.update(candidates).set({ status: "failed" }).where(eq(candidates.id, cand.id));
        await logEvent("error", `Failed on "${d.title}": ${(e as Error).message}`, "candidates", cand.id);
      }
    }
    if (capped) break;
  }

  await database.update(runs)
    .set({ finishedAt: new Date(), found, posted: collect.collected, skipped })
    .where(eq(runs.id, run.id));
  await logEvent("run",
    `Scout done — found ${found}, rendering ${rendering}, clips collected ${collect.collected}, skipped ${skipped}`);

  slog("scout_done", { found, rendering, collected: collect.collected, skipped });
  return { runId: run.id, found, rendering, collected: collect.collected, skipped };
}
