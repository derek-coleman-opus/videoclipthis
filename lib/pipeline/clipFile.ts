// Fresh video URLs for clips, on demand.
//
// WHY THIS EXISTS. OpusClip hands out SIGNED CDN URLS — both the preview and the HD export carry
// `?Expires=<epoch>`, and measured against a live account the two were 95 seconds apart, about
// 59 hours out — measured, not assumed. `clips.clipUrl` is written exactly once at collect time and then replayed forever:
// by the public library (/clips, /clips/[id], /speakers/[slug]), by the homepage showcase, by the
// admin review player, by the JSON-LD contentUrl fed to Google, and by every publish that happens
// later than the collect (a manual approve, or a drain held behind the daily cap). All of those
// were dead about two and a half days after the clip was made.
//
// The fix is not to find a durable URL — there isn't one. It is to stop treating a signed URL as
// a persistent identifier. `clips.opusClipId` plus `candidates.opusProjectId` are stable, and an
// export of an already-rendered clip is FREE and idempotent (verified against a live account:
// credits.remaining_minutes and monthly.used were byte-identical before and after, and the vendor
// contract is that a repeat export never starts a second render). So the URL is re-minted on
// demand and never trusted from storage.

import { eq } from "drizzle-orm";
import { db, candidates, clips } from "@/lib/db";
import { opusclipExportClip } from "./opusclip";
import { slog } from "./util";

/** How long a stored signed URL is assumed good.
 *
 *  MEASURED, not guessed: a captured pair expired 2026-10-10T16:41:30Z and 16:43:05Z against
 *  a mint time of 2026-10-08T05:20:34Z — a ~59-hour signature, not the ~24h first assumed. An
 *  hour of margin keeps a clip from being published on a URL about to die mid-upload, and the
 *  number is deliberately far below 59h so the window stays right if the vendor shortens it. */
const URL_TRUST_WINDOW_MS = Number(process.env.CLIP_URL_TRUST_MIN ?? 60) * 60 * 1000;

/** Read the `Expires=<epoch>` a signed OpusClip CDN URL carries, when it has one. */
export function urlExpiresAt(url: string): Date | null {
  const m = /[?&~]Expires=(\d{9,})/.exec(url);
  if (!m) return null;
  const secs = Number(m[1]);
  return Number.isFinite(secs) ? new Date(secs * 1000) : null;
}

/** True when a stored URL can still be handed out without re-minting it. */
export function urlStillGood(url: string, now = Date.now()): boolean {
  if (!url) return false;
  const exp = urlExpiresAt(url);
  if (!exp) return true; // unsigned URL — nothing to expire
  return exp.getTime() - now > URL_TRUST_WINDOW_MS;
}

/** A playable URL for this clip, re-exported if the stored one is stale or gone.
 *
 *  Returns null only when the clip cannot be resolved at all (no ids, or OpusClip says the export
 *  is unavailable AND nothing usable is stored) — callers decide whether that is fatal.
 *
 *  Costs nothing: re-exporting an already-rendered clip neither bills nor re-renders. */
export async function freshClipUrl(clipId: number): Promise<string | null> {
  const row = (await db()
    .select({
      storedUrl: clips.clipUrl,
      opusClipId: clips.opusClipId,
      opusProjectId: candidates.opusProjectId,
    })
    .from(clips)
    .leftJoin(candidates, eq(clips.candidateId, candidates.id))
    .where(eq(clips.id, clipId))
    .limit(1))[0];
  if (!row) return null;

  const stored = row.storedUrl ?? "";
  if (urlStillGood(stored)) return stored;

  // Stale or missing. Re-mint it if we have the ids to do so.
  if (!row.opusClipId || !row.opusProjectId) {
    // Nothing to re-export with. Hand back whatever is stored — an expired URL fails visibly at
    // the player or the uploader, which is strictly better than returning null and rendering a
    // "no clip" state for a clip that plainly exists.
    slog("clip_url_no_ids", { clipId, hasStored: Boolean(stored) });
    return stored || null;
  }

  const exported = await opusclipExportClip(
    row.opusProjectId,
    row.opusClipId,
    process.env.OPUSCLIP_API_KEY ?? "",
    process.env.OPUSCLIP_API_BASE ?? "",
  );
  if (exported.status === "ready" && exported.url) {
    // Cache the fresh URL so a burst of page views costs one export, not one per view.
    await db().update(clips).set({ clipUrl: exported.url }).where(eq(clips.id, clipId));
    return exported.url;
  }

  slog("clip_url_refresh_failed", { clipId, status: exported.status, detail: exported.detail });
  return stored || null;
}
