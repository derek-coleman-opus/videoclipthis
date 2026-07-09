import { asc, eq } from "drizzle-orm";
import { db, xbotDrafts } from "@/lib/db";
import { logEvent } from "@/lib/pipeline/events";
import { slog } from "@/lib/pipeline/util";
import { hasXbotWriteEnv } from "./env";
import { postDraft } from "./engagement";
import { reportHealth } from "./health";
import { assessAutoPost } from "./safety";
import { runLikes } from "./likes";
import { inQuietHours, pacingViolation, underCap } from "./guards";
import { getXbotSettings } from "./settings";

export interface PostingResult {
  posted: number;
  held: number;
  liked: number;
  skipped?: string;
}

function isReplyKind(kind: string): boolean {
  return kind === "reply" || kind === "followup" || kind === "engage" || kind === "plug";
}

/** The autonomy engine: post the drafts whose kind is set to auto, under the safety gate and
 *  all pacing rules, then run auto-likes. Kinds still on "review" are left in the queue for a
 *  human. Everything is gated so this is safe to run unattended on a cron:
 *   - paused / no-credentials / quiet-hours → posting no-ops (likes self-gate too)
 *   - safety gate holds anything sensitive/off-brand for manual review (never auto-posts it)
 *   - daily caps + hourly cap + min-gap make it drip ~one post per kind per run, not burst */
export async function runPostingDue(): Promise<PostingResult> {
  const settings = await getXbotSettings();
  const result: PostingResult = { posted: 0, held: 0, liked: 0 };
  if (settings.paused) return { ...result, skipped: "paused" };
  if (!hasXbotWriteEnv()) return { ...result, skipped: "no credentials" };

  // Posting waits for active hours; likes self-gate on quiet hours below.
  let postError: string | null = null;
  if (!inQuietHours(settings)) {
    const database = db();
    const drafts = await database.select().from(xbotDrafts)
      .where(eq(xbotDrafts.status, "pending_review"))
      .orderBy(asc(xbotDrafts.createdAt))
      .limit(50);

    for (const draft of drafts) {
      const reply = isReplyKind(draft.kind);
      const autoOn = reply ? settings.replyAutonomy === "auto" : settings.postAutonomy === "auto";
      if (!autoOn) continue; // this kind is on review — leave it for the human

      const capKind = draft.kind === "engage" ? "engage" : reply ? "reply" : "post";
      const cap = draft.kind === "engage" ? settings.dailyEngageCap
        : reply ? settings.dailyReplyCap : settings.dailyPostCap;

      // Cheap gates first: if this kind can't post right now, don't spend a safety call on it.
      if (!(await underCap(capKind, cap))) continue;
      if (await pacingViolation(capKind, cap, settings)) continue;

      const verdict = await assessAutoPost(draft.kind, draft.contextText ?? "", draft.text);
      if (!verdict.safe) {
        await database.update(xbotDrafts)
          .set({ status: "held", holdReason: verdict.reason ?? "held for review" })
          .where(eq(xbotDrafts.id, draft.id));
        await logEvent("xbot_held", `Held ${draft.kind} #${draft.id}: ${verdict.reason ?? ""}`, "xbot_drafts", draft.id);
        result.held++;
        continue;
      }

      try {
        await postDraft(draft);
        result.posted++;
      } catch (e) {
        // postDraft marks the draft failed + logs its own error; health tracks the pattern.
        postError = (e as Error).message;
        slog("xbot_posting_error", { draftId: draft.id, error: postError });
      }
    }
  }
  // Health: a run where posting attempts errored (and none succeeded) means auto-replies are
  // down — the exact silent failure the operator kept hitting on approve.
  await reportHealth("posting", !(postError !== null && result.posted === 0), postError ?? undefined);

  const likes = await runLikes();
  result.liked = likes.liked;

  await logEvent("xbot_run", `Posting run — posted ${result.posted}, held ${result.held}, liked ${result.liked}`);
  slog("xbot_posting", { ...result });
  return result;
}
