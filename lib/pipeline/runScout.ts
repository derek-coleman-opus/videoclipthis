import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db, candidates, runs } from "@/lib/db";
import { getSettings, parseWatchChannels, parseSearchTopics, updateSummonState } from "@/lib/settings";
import {
  DAILY_SOURCE_MINUTES_CAP, DEFAULT_THRESHOLD, MAX_CLIPS_PER_RUN, MAX_CONCURRENT_RENDERS,
  MAX_SUBMIT_ATTEMPTS, MIN_CREDITS_REMAINING, RENDER_SUBMIT_MULTIPLIER, FIGURE_SEARCH_INTERVAL_H,
  SEARCH_TOPICS, SEARCH_BUDGET_PER_BURST, WATCHLIST,
} from "./config";
import { requireScoutEnv } from "./env";
import { slog } from "./util";
import { buildSources } from "./sources";
import { claudeScorer } from "./scoring";
import { resolveXHandle } from "./handleResolver";
import { createProvablyNotBilled, opusclipCreateProject, opusclipUsage } from "./opusclip";
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
  queued: number;
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
    return { runId: run.id, found: 0, rendering: 0, queued: 0, collected: 0, skipped: 0, paused: true };
  }

  // Phase B first: collect any renders that finished since the last run (clips queue/post here).
  const collect = await collectRenders();

  const figures = await getFigures();
  // Figure + topic searches cost 100 YouTube quota units each — only run them every few hours,
  // and only a rotating budget-sized window per burst (advance the offset so the whole list is
  // covered across the day without blowing quota).
  const searchDue =
    !cfg.figureSearchAt ||
    Date.now() - new Date(cfg.figureSearchAt).getTime() >= FIGURE_SEARCH_INTERVAL_H * 3600 * 1000;
  const topicList = parseSearchTopics(cfg).length ? parseSearchTopics(cfg) : SEARCH_TOPICS;
  const searchTerms = [
    ...figures.map((f) => ({ term: f.name, figure: f })),
    ...topicList.map((t) => ({ term: t })),
  ];
  const watchedChannels = parseWatchChannels(cfg).length ? parseWatchChannels(cfg) : WATCHLIST.youtubeChannels;
  // Channel name → its X handle, for brand tags on search-discovered videos of watched channels.
  const brandXByName = new Map(
    watchedChannels.filter((c) => c.xHandle).map((c) => [c.name.toLowerCase(), c.xHandle as string]),
  );
  const sources = buildSources(figures, {
    channels: parseWatchChannels(cfg), // settings override → point the bot at any niche
    search: searchDue ? { terms: searchTerms, budget: SEARCH_BUDGET_PER_BURST, offset: cfg.searchOffset ?? 0 } : null,
  });
  if (searchDue) {
    const next = searchTerms.length
      ? (Number(cfg.searchOffset ?? 0) + SEARCH_BUDGET_PER_BURST) % searchTerms.length
      : 0;
    await updateSummonState({ figureSearchAt: new Date(), searchOffset: next });
  }
  const scorer = claudeScorer(process.env.ANTHROPIC_API_KEY ?? "", cfg.niche ?? "");
  // Handle-resolution spend cap per run (each resolution = 1-3 Claude calls + 1-3 X reads,
  // cached forever after). The cache means steady state costs ~nothing.
  let resolveBudget = Number(process.env.HANDLE_RESOLVE_PER_RUN ?? 6);
  const opusKey = process.env.OPUSCLIP_API_KEY ?? "";
  const opusBase = process.env.OPUSCLIP_API_BASE ?? "";
  const threshold = cfg.threshold ?? DEFAULT_THRESHOLD;

  let found = 0, rendering = 0, queued = 0, skipped = 0;

  // Render backpressure: OpusClip caps concurrent projects, so only submit up to the number of
  // free slots. Candidates that pass the gate but can't fit are left "scored" and submitted on a
  // later run (drained newest-best-first below) — never over-submitted and burned.
  const inFlight = Number(
    (await database.select({ n: sql<number>`count(*)::int` })
      .from(candidates).where(eq(candidates.status, "rendering")))[0]?.n ?? 0,
  );
  // Hardening caps, enforced at SUBMIT time — because that is when OpusClip bills, at roughly
  // 1 credit per minute of source video. Posting caps (dailyClipCap + pacing) throttle output;
  // these throttle SPEND, which is a different number and used to be unbounded.
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const submittedToday = await database
    .select({
      n: sql<number>`count(*)::int`,
      minutes: sql<number>`coalesce(sum(${candidates.durationS}), 0)::float / 60`,
    })
    .from(candidates)
    .where(gte(candidates.renderStartedAt, dayStart));
  const rendersToday = Number(submittedToday[0]?.n ?? 0);
  let sourceMinutesToday = Number(submittedToday[0]?.minutes ?? 0);

  // Never submit more per day than you could plausibly post (dailyClipCap × allowance).
  const dailySubmitCap = Math.max(1, (cfg.dailyClipCap ?? 6) * RENDER_SUBMIT_MULTIPLIER);
  let slots = Math.max(0, Math.min(
    MAX_CONCURRENT_RENDERS - inFlight,
    MAX_CLIPS_PER_RUN,
    dailySubmitCap - rendersToday,
  ));
  if (slots === 0 && rendersToday >= dailySubmitCap) {
    await logEvent("run", `Daily render-submit cap reached (${rendersToday}/${dailySubmitCap}) — no new renders today`);
  }
  if (slots > 0 && sourceMinutesToday >= DAILY_SOURCE_MINUTES_CAP) {
    slots = 0;
    await logEvent("run",
      `Daily source-video budget reached (${Math.round(sourceMinutesToday)}/${DAILY_SOURCE_MINUTES_CAP} min ≈ credits) — no new renders today`);
  }

  // Plan-level floor: don't start a render that could push the account past its monthly credits.
  // Best-effort — an unreachable or unrecognized usage response must never stall the pipeline.
  if (slots > 0) {
    try {
      const usage = await opusclipUsage(opusKey, opusBase);
      if (!usage.uncapped && usage.remaining != null && usage.remaining < MIN_CREDITS_REMAINING) {
        slots = 0;
        await logEvent("error",
          `OpusClip credits nearly exhausted (${usage.remaining} left of ${usage.limit ?? "?"}) — holding renders`);
      }
    } catch (e) {
      slog("opusclip_usage_check_failed", { error: (e as Error).message });
    }
  }
  slog("scout_start", {
    threshold, collected: collect.collected, inFlight, slots,
    rendersToday, dailySubmitCap, sourceMinutesToday: Math.round(sourceMinutesToday),
  });

  /** Submit one candidate's render; consumes a slot on success.
   *
   *  Failure is RETRIABLE, not terminal: the create POST is no longer retried at the HTTP layer
   *  (repeating a billed, non-idempotent POST is how one video becomes three charges), so a
   *  transient failure leaves the candidate "scored" for the next run's backlog drain — which is
   *  safe because that drain only picks up candidates with no project id yet. `submit_attempts`
   *  bounds it so a permanently-bad URL can't be re-submitted forever. */
  async function submitRender(c: {
    id: number; url: string; title: string; durationS?: number | null; submitAttempts?: number | null;
    speaker?: string | null; figureName?: string | null; channel?: string | null; score?: number | null;
  }): Promise<void> {
    // A single long video can blow the day's budget on its own — check this candidate's own
    // length against what is left, and leave it queued rather than overspending.
    const minutes = Math.max(0, (c.durationS ?? 0) / 60);
    if (sourceMinutesToday + minutes > DAILY_SOURCE_MINUTES_CAP) {
      queued++;
      await logEvent("scored",
        `Queued — ${Math.round(minutes)} min source would exceed today's ${DAILY_SOURCE_MINUTES_CAP} min budget: ${c.title}`,
        "candidates", c.id);
      return;
    }

    const attempts = (c.submitAttempts ?? 0) + 1;
    try {
      // Count the attempt BEFORE the call: if the response is lost after OpusClip already
      // created (and billed) the project, the attempt still has to count against the budget.
      await database.update(candidates).set({ submitAttempts: attempts }).where(eq(candidates.id, c.id));
      const projectId = await opusclipCreateProject(c.url, opusKey, opusBase, {
        title: c.title, speaker: c.speaker || c.figureName || undefined, channel: c.channel || undefined,
      }, cfg.opusBrandTemplateId);
      await database.update(candidates)
        .set({ status: "rendering", opusProjectId: projectId, renderStartedAt: new Date() })
        .where(eq(candidates.id, c.id));
      rendering++; slots--; sourceMinutesToday += minutes;
      await logEvent("rendering", `Rendering [${c.score ?? "?"}]: ${c.title} (OpusClip ${projectId})`, "candidates", c.id);
    } catch (e) {
      // Only re-submit when the failure PROVES nothing was created. A timeout or 5xx may have left
      // a billed project behind whose id we never saw — retrying that would pay twice, so it is
      // terminal and surfaced for the operator instead.
      const safeToRetry = createProvablyNotBilled(e);
      const terminal = !safeToRetry || attempts >= MAX_SUBMIT_ATTEMPTS;
      await database.update(candidates)
        .set({ status: terminal ? "failed" : "scored" })
        .where(eq(candidates.id, c.id));
      await logEvent("error",
        terminal
          ? `Render submit failed on "${c.title}"${safeToRetry ? "" : " — ambiguous outcome, NOT retried (a project may already have been billed; check OpusClip before re-running)"}: ${(e as Error).message}`
          : `Render submit failed (attempt ${attempts}/${MAX_SUBMIT_ATTEMPTS}, will retry) on "${c.title}": ${(e as Error).message}`,
        "candidates", c.id);
    }
  }

  // Drain the backlog first: candidates that passed the gate on a prior run but waited for a slot.
  if (slots > 0) {
    const backlog = await database.select().from(candidates)
      .where(and(
        eq(candidates.status, "scored"),
        isNull(candidates.opusProjectId),
        sql`${candidates.score} >= ${threshold}`,
        sql`${candidates.submitAttempts} < ${MAX_SUBMIT_ATTEMPTS}`,
      ))
      .orderBy(desc(candidates.score))
      .limit(slots);
    for (const c of backlog) {
      if (slots <= 0) break;
      await submitRender(c);
    }
  }

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

      // Brand tag fallback for search-discovered videos: when the video's channel is one of
      // the configured watched channels (matched by name), carry its X handle so the post can
      // tag the brand ("via @…") even though discovery came via search, not the channel feed.
      if (!d.channelXHandle && d.channel) {
        d.channelXHandle = brandXByName.get(d.channel.toLowerCase());
      }

      // Track key AI figures: if a tracked figure is the speaker, resolve their @ so we can
      // always credit + tag them (turns an un-attributed talk into a creditable clip).
      const fig = matchFigure(figures, d);
      if (fig) {
        d.figureName = fig.name;
        if (!d.speakerHandle) d.speakerHandle = fig.xHandle;
      }

      // Dedup — never reprocess (or re-pay for) a video we've already seen. The insert carries
      // ON CONFLICT DO NOTHING against candidates_video_id_uniq rather than trusting a prior
      // SELECT: two overlapping runs (the 30-min cron plus a manual "Run Scout now") can both
      // pass a select-then-insert check and submit two paid renders of the same video.
      const inserted = await database.insert(candidates).values({
        source: d.source, url: d.url, videoId: d.videoId, title: d.title,
        speaker: d.speaker ?? "", speakerHandle: d.speakerHandle ?? "",
        channel: d.channel ?? "", channelXHandle: d.channelXHandle ?? "", event: d.event ?? "",
        durationS: d.durationS ?? 0, signalStrength: d.signalStrength ?? 0,
        figureName: d.figureName ?? null,
        status: "found",
      }).onConflictDoNothing().returning();
      if (!inserted.length) { skipped++; continue; } // already known — the DB rejected the duplicate
      const cand = inserted[0];
      await logEvent("found", `Found: ${d.title} (${src.name})${fig ? ` · 🎯 ${fig.name}` : ""}`, "candidates", cand.id);

      try {
      const scored = await scorer.score(d);
      // "Tag the speaker, not the brand": the scorer extracts the human speaker from the
      // title/transcript. A person's name can also match a tracked figure → their verified @.
      if (!d.speaker && scored.speakerName && scored.speakerName.toLowerCase() !== (d.channel ?? "").toLowerCase()) {
        d.speaker = scored.speakerName;
        const fig2 = matchFigure(figures, d);
        if (fig2) {
          d.figureName = fig2.name;
          if (!d.speakerHandle) d.speakerHandle = fig2.xHandle;
        }
        await database.update(candidates)
          .set({ speaker: d.speaker, speakerHandle: d.speakerHandle ?? "", figureName: d.figureName ?? null })
          .where(eq(candidates.id, cand.id));
      }
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

      // Best-effort tag resolution — AFTER the score gate so it only spends on clips that will
      // actually render. Claude proposes handles, the live X profile verifies (wrong tag is
      // worse than no tag); results are cached so each name costs API calls once. Failure to
      // resolve NEVER holds the clip — it posts with a text-name credit instead.
      const resolveCtx = `speaker/channel of "${d.title}"${d.channel ? ` (YouTube channel: ${d.channel})` : ""}`;
      if (!d.speakerHandle && d.speaker && resolveBudget > 0) {
        resolveBudget--;
        d.speakerHandle = (await resolveXHandle("person", d.speaker, resolveCtx)) ?? undefined;
      }
      if (!d.channelXHandle && d.channel && resolveBudget > 0) {
        resolveBudget--;
        d.channelXHandle = (await resolveXHandle("brand", d.channel, resolveCtx)) ?? undefined;
      }
      if (d.speakerHandle || d.channelXHandle) {
        await database.update(candidates)
          .set({ speakerHandle: d.speakerHandle ?? "", channelXHandle: d.channelXHandle ?? "" })
          .where(eq(candidates.id, cand.id));
      }

      // Only a clip with NO attribution at all (no name, no handle, no channel) is held.
      if (needsCreditResolution(d)) {
        await database.update(candidates).set({ status: "held" }).where(eq(candidates.id, cand.id));
        await logEvent("held", `Held [${score}] — no attribution at all: ${d.title}`, "candidates", cand.id);
        skipped++; continue;
      }

      // Submit only if OpusClip has a free concurrency slot; otherwise leave the candidate
      // "scored" (already set above) so a later run drains it from the backlog.
      if (slots > 0) {
        await submitRender({
          id: cand.id, url: d.url, title: d.title,
          durationS: d.durationS ?? 0, submitAttempts: cand.submitAttempts,
          speaker: d.speaker, figureName: d.figureName, channel: d.channel, score,
        });
      } else {
        queued++;
        await logEvent("scored", `Queued [${score}] — ${MAX_CONCURRENT_RENDERS} renders already in flight: ${d.title}`, "candidates", cand.id);
      }
      } catch (e) {
        await database.update(candidates).set({ status: "failed" }).where(eq(candidates.id, cand.id));
        await logEvent("error", `Failed on "${d.title}": ${(e as Error).message}`, "candidates", cand.id);
      }
    }
  }

  await database.update(runs)
    .set({ finishedAt: new Date(), found, posted: collect.posted, skipped })
    .where(eq(runs.id, run.id));
  await logEvent("run",
    `Scout done — found ${found}, rendering ${rendering}, queued ${queued}, collected ${collect.collected}, posted ${collect.posted}, skipped ${skipped}`);

  slog("scout_done", { found, rendering, queued, collected: collect.collected, skipped });
  return { runId: run.id, found, rendering, queued, collected: collect.collected, skipped };
}
