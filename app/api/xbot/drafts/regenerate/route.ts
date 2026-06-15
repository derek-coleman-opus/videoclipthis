import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, xbotDrafts, xbotTargets, xbotTweets, type XbotDraft } from "@/lib/db";
import { logEvent } from "@/lib/pipeline/events";
import { requireXbotDraftEnv } from "@/lib/xbot/env";
import {
  draftEngageBack, draftPlugReply, draftPostVariants, draftReply, type DraftStyle, type Drafted,
} from "@/lib/xbot/drafting";
import { isDuplicateText, lowValueReason } from "@/lib/xbot/guards";
import { getXbotSettings } from "@/lib/xbot/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const STYLES: DraftStyle[] = ["auto", "funny", "informative", "contrarian"];

/** Regenerate an existing pending draft in place, optionally in a chosen style
 *  (auto | funny | informative | contrarian). Re-derives the original tweet/context
 *  from the stored draft, redrafts via the same engine + guards, and overwrites the row.
 *  Lets the reviewer iterate on a draft instead of reject-and-repaste. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  const style: DraftStyle = STYLES.includes(body.style) ? body.style : "auto";
  if (!id) return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });

  try {
    requireXbotDraftEnv();
    const settings = await getXbotSettings();
    const database = db();

    const draft = (await database.select().from(xbotDrafts).where(eq(xbotDrafts.id, id)).limit(1))[0];
    if (!draft) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    if (draft.status !== "pending_review") {
      return NextResponse.json({ ok: false, error: `draft is ${draft.status}` }, { status: 409 });
    }

    const voiceNotes = settings.voiceNotes ?? "";
    const mission = settings.mission ?? "";
    let drafted: Drafted;

    if (draft.kind === "reply" || draft.kind === "followup") {
      const { handle, bio } = await authorContext(draft);
      const prior = draft.kind === "followup" ? await priorInteraction(draft.targetId) : {};
      drafted = await draftReply({
        tweetText: draft.contextText ?? "",
        authorHandle: handle || "there",
        authorBio: bio,
        voiceNotes, mission, style,
        priorReply: prior.reply, priorTweet: prior.tweet,
      });
    } else if (draft.kind === "engage") {
      const { handle } = await authorContext(draft);
      drafted = await draftEngageBack({
        theirText: draft.contextText ?? "",
        theirHandle: handle || "there",
        voiceNotes, mission, style,
      });
    } else if (draft.kind === "post") {
      const variants = await draftPostVariants(voiceNotes, mission, style);
      drafted = variants[0];
    } else if (draft.kind === "plug") {
      if (!settings.productUrl) {
        return NextResponse.json({ ok: false, error: "set Product URL in XBot Settings first" }, { status: 400 });
      }
      drafted = await draftPlugReply({
        postText: draft.contextText || draft.text,
        productUrl: settings.productUrl, voiceNotes, mission,
      });
    } else {
      return NextResponse.json({ ok: false, error: `cannot regenerate kind ${draft.kind}` }, { status: 400 });
    }

    const lowValue = lowValueReason(drafted.text, draft.kind);
    if (lowValue) {
      return NextResponse.json({ ok: false, error: `regenerated draft rejected: ${lowValue} — try again` }, { status: 422 });
    }
    if (await isDuplicateText(drafted.text)) {
      return NextResponse.json({ ok: false, error: "regenerated text duplicates a recent draft — try again" }, { status: 422 });
    }

    const [updated] = await database.update(xbotDrafts)
      .set({
        text: drafted.text,
        rationale: drafted.rationale,
        ...(drafted.mediaIdea !== undefined ? { mediaIdea: drafted.mediaIdea } : {}),
        editedByHuman: false,
      })
      .where(eq(xbotDrafts.id, id))
      .returning();
    await logEvent("xbot_drafted", `Regenerated ${draft.kind} (${style})`, "xbot_drafts", id);
    return NextResponse.json({ ok: true, draft: updated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/** Resolve the other party's handle + bio from the draft's target or recorded tweet. */
async function authorContext(draft: XbotDraft): Promise<{ handle: string; bio: string }> {
  if (draft.targetId) {
    const t = (await db().select().from(xbotTargets).where(eq(xbotTargets.id, draft.targetId)).limit(1))[0];
    if (t) return { handle: t.handle, bio: t.bio ?? "" };
  }
  if (draft.tweetRefId) {
    const tw = (await db().select().from(xbotTweets).where(eq(xbotTweets.id, draft.tweetRefId)).limit(1))[0];
    if (tw) return { handle: tw.authorHandle, bio: "" };
  }
  return { handle: "", bio: "" };
}

/** Last reply we posted to this target, for follow-up continuity (mirrors the generate route). */
async function priorInteraction(targetId: number | null): Promise<{ reply?: string; tweet?: string }> {
  if (!targetId) return {};
  const last = (await db()
    .select().from(xbotDrafts)
    .where(eq(xbotDrafts.targetId, targetId))
    .orderBy(desc(xbotDrafts.postedAt))
    .limit(50))
    .find((d) => d.status === "posted" && (d.kind === "reply" || d.kind === "followup"));
  return last ? { reply: last.text, tweet: last.contextText ?? "" } : {};
}
