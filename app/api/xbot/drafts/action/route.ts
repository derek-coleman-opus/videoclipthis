import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, xbotDrafts } from "@/lib/db";
import { hasXbotWriteEnv } from "@/lib/xbot/env";
import { postDraft } from "@/lib/xbot/engagement";
import { isDuplicateText } from "@/lib/xbot/guards";
import { MAX_DRAFT_CHARS } from "@/lib/xbot/config";

export const dynamic = "force-dynamic";

/** Approve (optionally with edited text) or reject a queued draft.
 *  Approve posts immediately when the personal-account X tokens are configured;
 *  before then it just marks the draft approved (copy-paste it yourself). */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  const action = String(body.action);
  if (!id || (action !== "approve" && action !== "reject")) {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }

  const database = db();
  const draft = (await database.select().from(xbotDrafts).where(eq(xbotDrafts.id, id)).limit(1))[0];
  if (!draft) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  if (draft.status !== "pending_review") {
    return NextResponse.json({ ok: false, error: `draft is ${draft.status}` }, { status: 409 });
  }

  if (action === "reject") {
    await database.update(xbotDrafts).set({ status: "rejected" }).where(eq(xbotDrafts.id, id));
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  // Human edits override Claude's text.
  let text = draft.text;
  if (typeof body.text === "string" && body.text.trim() && body.text.trim() !== draft.text) {
    text = body.text.trim();
    if (text.length > MAX_DRAFT_CHARS + 10) {
      return NextResponse.json({ ok: false, error: `over ${MAX_DRAFT_CHARS} characters` }, { status: 400 });
    }
  }
  if (await isDuplicateText(text)) {
    return NextResponse.json(
      { ok: false, error: "text duplicates a recent reply/post — edit it first" },
      { status: 422 },
    );
  }
  const edited = text !== draft.text;
  const [approved] = await database.update(xbotDrafts)
    .set({ text, editedByHuman: edited || draft.editedByHuman, status: "approved" })
    .where(eq(xbotDrafts.id, id))
    .returning();

  if (!hasXbotWriteEnv()) {
    return NextResponse.json({
      ok: true, status: "approved",
      note: "X credentials not configured — draft is approved and queued, post it manually for now",
    });
  }

  try {
    const { xPostId } = await postDraft(approved);
    return NextResponse.json({ ok: true, status: "posted", xPostId });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
