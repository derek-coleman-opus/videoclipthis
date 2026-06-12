import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, xbotDrafts, xbotTargets, xbotTweets } from "@/lib/db";
import { logEvent } from "@/lib/pipeline/events";
import { requireXbotDraftEnv } from "@/lib/xbot/env";
import { draftPostVariants, draftReply } from "@/lib/xbot/drafting";
import { isDuplicateText } from "@/lib/xbot/guards";
import { getXbotSettings } from "@/lib/xbot/settings";

export const dynamic = "force-dynamic";
// Claude drafting can take a while when generating multiple variants.
export const maxDuration = 120;

function parseTweetUrl(url: string): { tweetId: string; handle: string } | null {
  const m = url.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
  return m ? { handle: m[1], tweetId: m[2] } : null;
}

/** On-demand drafting — the Phase 1 workhorse. Needs only DATABASE_URL + ANTHROPIC_API_KEY.
 *  kind "post": generate original-post variants from voiceNotes.
 *  kind "reply": paste a tweet URL + its text, get a Claude reply draft into the queue. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const kind = String(body.kind ?? "");
  try {
    requireXbotDraftEnv();
    const settings = await getXbotSettings();
    const database = db();

    if (kind === "post") {
      const variants = await draftPostVariants(settings.voiceNotes ?? "");
      const created = [];
      for (const v of variants) {
        if (await isDuplicateText(v.text)) continue;
        const [row] = await database.insert(xbotDrafts).values({
          kind: "post", text: v.text, rationale: v.rationale,
        }).returning();
        created.push(row);
      }
      if (!created.length) {
        return NextResponse.json(
          { ok: false, error: "all variants duplicated recent posts — add fresh material to voice notes" },
          { status: 422 },
        );
      }
      await logEvent("xbot_drafted", `Drafted ${created.length} post variant(s)`, "xbot_drafts", created[0].id);
      return NextResponse.json({ ok: true, drafts: created });
    }

    if (kind === "reply") {
      const tweetText = String(body.tweetText ?? "").trim();
      const parsed = parseTweetUrl(String(body.tweetUrl ?? ""));
      if (!parsed || !tweetText) {
        return NextResponse.json(
          { ok: false, error: "tweetUrl (x.com/<handle>/status/<id>) and tweetText are required" },
          { status: 400 },
        );
      }

      // Attach to an existing target when the author is one; otherwise draft standalone.
      const target = (await database
        .select().from(xbotTargets)
        .where(eq(xbotTargets.handle, parsed.handle)).limit(1))[0];

      // Record the tweet (dedup by tweetId) so re-engagement history has an anchor.
      let tweetRef = (await database
        .select().from(xbotTweets)
        .where(eq(xbotTweets.tweetId, parsed.tweetId)).limit(1))[0];
      if (!tweetRef) {
        [tweetRef] = await database.insert(xbotTweets).values({
          tweetId: parsed.tweetId,
          targetId: target?.id ?? null,
          authorHandle: parsed.handle,
          text: tweetText,
          foundVia: "manual",
          status: "drafted",
        }).returning();
      }

      const isFollowup = Boolean(target && (target.repliesSent ?? 0) > 0);
      let prior: { reply?: string; tweet?: string } = {};
      if (isFollowup && target) {
        const lastDraft = (await database
          .select().from(xbotDrafts)
          .where(eq(xbotDrafts.targetId, target.id))
          .limit(50))
          .filter((d) => d.status === "posted" && (d.kind === "reply" || d.kind === "followup"))
          .sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0))[0];
        if (lastDraft) prior = { reply: lastDraft.text, tweet: lastDraft.contextText ?? "" };
      }

      const drafted = await draftReply({
        tweetText,
        authorHandle: parsed.handle,
        authorBio: target?.bio ?? "",
        voiceNotes: settings.voiceNotes ?? "",
        priorReply: prior.reply,
        priorTweet: prior.tweet,
      });
      if (await isDuplicateText(drafted.text)) {
        return NextResponse.json(
          { ok: false, error: "draft duplicated a recent reply — regenerate" },
          { status: 422 },
        );
      }
      const [row] = await database.insert(xbotDrafts).values({
        kind: isFollowup ? "followup" : "reply",
        targetId: target?.id ?? null,
        tweetRefId: tweetRef.id,
        inReplyToTweetId: parsed.tweetId,
        contextText: tweetText,
        text: drafted.text,
        rationale: drafted.rationale,
      }).returning();
      await logEvent("xbot_drafted", `Drafted ${row.kind} to @${parsed.handle}`, "xbot_drafts", row.id);
      return NextResponse.json({ ok: true, drafts: [row] });
    }

    return NextResponse.json({ ok: false, error: "kind must be 'post' or 'reply'" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
