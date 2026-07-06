import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, clips } from "@/lib/db";
import { requireXEnv } from "@/lib/pipeline/env";
import { logEvent } from "@/lib/pipeline/events";
import { markClipPosted } from "@/lib/pipeline/render";
import { xPublisher } from "@/lib/pipeline/publishing";

export const dynamic = "force-dynamic";
// Pro budget: video upload + X media processing wait can exceed 60s.
export const maxDuration = 300;

/** Approve (→ publish to X, optionally with edited post text) or reject a clip.
 *  Approve also works on "failed" clips (retry a transient publish error without losing the
 *  paid render) and "approved" clips (post now instead of waiting for the paced drain).
 *  Admin basic-auth via middleware. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  const action = String(body.action);
  if (!id || (action !== "approve" && action !== "reject")) {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }

  const database = db();
  const clip = (await database.select().from(clips).where(eq(clips.id, id)).limit(1))[0];
  if (!clip) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  const actionable = ["pending_review", "failed", "approved"].includes(clip.status);
  if (!actionable) {
    return NextResponse.json({ ok: false, error: `clip is ${clip.status}` }, { status: 409 });
  }

  if (action === "reject") {
    await database.update(clips).set({ status: "rejected" }).where(eq(clips.id, id));
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  // Human edits override the composed text (fix a typo without discarding the render).
  let postText = clip.postText;
  if (typeof body.text === "string" && body.text.trim() && body.text.trim() !== clip.postText) {
    postText = body.text.trim().slice(0, 280);
    await database.update(clips).set({ postText }).where(eq(clips.id, id));
  }

  try {
    requireXEnv();
    const result = await xPublisher().publish(
      {
        clipUrl: clip.clipUrl ?? "",
        postText,
        costUsd: clip.costUsd ?? 0,
        durationS: Math.max(0, Math.round((clip.endS ?? 0) - (clip.startS ?? 0))),
      },
      clip.replyTo ?? null,
    );
    await markClipPosted({ ...clip, postText }, result.xPostId);
    return NextResponse.json({ ok: true, status: "posted", xPostId: result.xPostId });
  } catch (e) {
    const reason = (e as Error).message.slice(0, 500);
    await database.update(clips).set({ status: "failed", failReason: reason }).where(eq(clips.id, id));
    await logEvent("error", `Publish failed for clip #${id}: ${reason}`, "clips", id);
    return NextResponse.json({ ok: false, error: reason }, { status: 500 });
  }
}
