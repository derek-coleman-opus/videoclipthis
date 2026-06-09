import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, clips } from "@/lib/db";
import { requireXEnv } from "@/lib/pipeline/env";
import { xPublisher } from "@/lib/pipeline/publishing";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Approve (→ publish to X) or reject a clip waiting in the review queue. Admin basic-auth (middleware).
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
  if (clip.status !== "pending_review") {
    return NextResponse.json({ ok: false, error: `clip is ${clip.status}` }, { status: 409 });
  }

  if (action === "reject") {
    await database.update(clips).set({ status: "rejected" }).where(eq(clips.id, id));
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  try {
    requireXEnv();
    const publisher = xPublisher();
    const result = await publisher.publish(
      { clipUrl: clip.clipUrl ?? "", postText: clip.postText, costUsd: clip.costUsd ?? 0 },
      clip.replyTo ?? null,
    );
    await database.update(clips)
      .set({ status: "posted", xPostId: result.xPostId, postedAt: new Date() })
      .where(eq(clips.id, id));
    return NextResponse.json({ ok: true, status: "posted", xPostId: result.xPostId });
  } catch (e) {
    await database.update(clips).set({ status: "failed" }).where(eq(clips.id, id));
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
