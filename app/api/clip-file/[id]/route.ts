import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, clips } from "@/lib/db";
import { freshClipUrl } from "@/lib/pipeline/clipFile";
import { withSchemaHeal } from "@/lib/db/ensureSchema";

export const dynamic = "force-dynamic";

/** A STABLE URL for a clip's video, which the signed CDN URL is not.
 *
 *  Every public surface links here instead of embedding `clips.clipUrl` directly, because that
 *  column holds a signed URL that dies in ~59h while the pages that replay it live
 *  forever. This re-mints the URL when it has gone stale (free — see lib/pipeline/clipFile.ts)
 *  and redirects.
 *
 *  PUBLIC BY DESIGN, and deliberately narrow: it serves `posted` clips only, so it exposes
 *  exactly what the public library already shows and nothing in the review queue. Add it to
 *  middleware's public list alongside /clips.
 *
 *  302, not 307 or a proxy: the bytes come straight from OpusClip's CDN rather than through a
 *  serverless function, and the redirect is explicitly non-cacheable because its target expires. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withSchemaHeal(async () => {
    const { id: raw } = await ctx.params;
    const id = Number(raw);
    if (!id || !Number.isFinite(id)) {
      return NextResponse.json({ error: "bad id" }, { status: 400 });
    }

    const row = (await db()
      .select({ status: clips.status })
      .from(clips)
      .where(eq(clips.id, id))
      .limit(1))[0];
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (row.status !== "posted") {
      // Unposted clips are not public. 404 rather than 403: the existence of a clip in review is
      // itself not public information.
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const url = await freshClipUrl(id);
    if (!url) {
      return NextResponse.json(
        { error: "the rendered file is no longer available from OpusClip" },
        { status: 404 },
      );
    }

    return NextResponse.redirect(url, {
      status: 302,
      // The target is a signed URL with its own expiry, so neither the browser nor a CDN may hold
      // this redirect: a cached 302 would outlive the URL it points at and serve a dead link.
      headers: { "cache-control": "no-store, max-age=0" },
    });
  });
}
