// Multi-platform distribution: after a clip is posted, push the SAME rendered clip to every
// social account enabled in settings (TikTok, YouTube Shorts, Instagram, LinkedIn — whatever
// is connected in the OpusClip dashboard) via OpusClip post-tasks. Born from the X account
// lock: distribution must never depend on a single platform again.
//
// Design rules:
//   - Never throws: a cross-post failure must not fail the X publish that triggered it.
//   - Every attempt (success or failure) is recorded in clip_publishes — the admin shows
//     per-platform badges, silence is not an option.
//   - Scout clips only: summon clips are in-thread X replies; re-posting them standalone
//     elsewhere would strip their context.

import { eq } from "drizzle-orm";
import { db, clipPublishes, candidates, type Clip, type Settings } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { opusclipCreatePostTask, type OpusSocialAccount } from "./opusclip";
import { logEvent } from "./events";
import { sleep, slog } from "./util";

/** Parse settings.crosspostAccounts (JSON array persisted by the admin picker). */
export function parseCrosspostAccounts(s: Settings): OpusSocialAccount[] {
  try {
    const arr = JSON.parse(s.crosspostAccounts ?? "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .map((a: any) => ({
        postAccountId: String(a.postAccountId ?? ""),
        subAccountId: a.subAccountId ? String(a.subAccountId) : null,
        platform: String(a.platform ?? ""),
        name: String(a.name ?? ""),
      }))
      .filter((a) => a.postAccountId && a.platform);
  } catch {
    return [];
  }
}

/** Short platform label for events/UI. */
export function platformLabel(platform: string): string {
  const map: Record<string, string> = {
    YOUTUBE: "YouTube",
    TIKTOK_BUSINESS: "TikTok",
    INSTAGRAM_BUSINESS: "Instagram",
    FACEBOOK_PAGE: "Facebook",
    LINKEDIN: "LinkedIn",
    TWITTER: "X",
  };
  return map[platform] ?? platform;
}

/** Cross-post a just-posted scout clip to every enabled account. Never throws. */
export async function crossPostClip(clip: Clip, cfg?: Settings): Promise<void> {
  try {
    if (clip.kind !== "scout") return;
    const settings = cfg ?? (await getSettings());
    const accounts = parseCrosspostAccounts(settings);
    if (!accounts.length) return;

    if (!clip.opusClipId || !clip.candidateId) {
      slog("crosspost_skip", { clipId: clip.id, reason: "no opusClipId/candidateId (pre-crosspost clip)" });
      return;
    }
    const database = db();
    const candidate = (await database
      .select({ opusProjectId: candidates.opusProjectId })
      .from(candidates)
      .where(eq(candidates.id, clip.candidateId)).limit(1))[0];
    const projectId = candidate?.opusProjectId;
    if (!projectId) {
      slog("crosspost_skip", { clipId: clip.id, reason: "candidate has no opusProjectId" });
      return;
    }
    // Exportable-clip ids can come back as the composite "{projectId}.{clipId}" — post-tasks
    // want the two parts separately.
    const clipId = clip.opusClipId.startsWith(`${projectId}.`)
      ? clip.opusClipId.slice(projectId.length + 1)
      : clip.opusClipId;

    const apiKey = process.env.OPUSCLIP_API_KEY ?? "";
    const base = process.env.OPUSCLIP_API_BASE ?? "";
    const title = (clip.hookCaption || clip.postText).slice(0, 95);
    // The X post text ends with handle tags + the source link — platform-neutral enough to
    // reuse as the description everywhere (credit-first is the whole brand).
    const description = clip.postText;

    const results: string[] = [];
    for (const [i, account] of accounts.entries()) {
      if (i > 0) await sleep(1100); // POST /post-tasks is limited to 1 req/s
      try {
        const taskId = await opusclipCreatePostTask(
          {
            projectId, clipId,
            postAccountId: account.postAccountId,
            subAccountId: account.subAccountId,
            title, description,
          },
          apiKey, base,
        );
        await database.insert(clipPublishes).values({
          clipId: clip.id, platform: account.platform,
          postAccountId: account.postAccountId, accountName: account.name,
          status: "posted", taskId,
        });
        results.push(platformLabel(account.platform));
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        await database.insert(clipPublishes).values({
          clipId: clip.id, platform: account.platform,
          postAccountId: account.postAccountId, accountName: account.name,
          status: "failed", error: msg,
        });
        await logEvent("error", `Cross-post to ${platformLabel(account.platform)} failed for clip #${clip.id}: ${msg}`, "clips", clip.id);
      }
    }
    if (results.length) {
      await logEvent("posted", `Cross-posted clip #${clip.id} to ${results.join(", ")}`, "clips", clip.id);
      slog("crosspost", { clipId: clip.id, platforms: results });
    }
  } catch (e) {
    // Absolute backstop: cross-posting must never break the publish path that called it.
    slog("crosspost_error", { clipId: clip.id, error: (e as Error).message });
  }
}
