import { NextResponse } from "next/server";
import { applyMigrations } from "@/lib/db/ensureSchema";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One-click schema sync (admin basic-auth via middleware). Open in a browser:
//   GET /api/admin/migrate
//
// The statements themselves live in lib/db/ensureSchema.ts, shared with the automatic self-heal
// that runs when getSettings() hits a missing column. This endpoint stays because it is the way to
// apply the schema DELIBERATELY — before a deploy, or to see per-statement results when something
// fails — but forgetting it is no longer an outage.
export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL is not set" }, { status: 500 });
  }
  const results = await applyMigrations();
  const failed = results.filter((r) => !r.ok).length;
  return NextResponse.json({
    ok: failed === 0,
    applied: results.length - failed,
    failed,
    results,
    next: "Now open /api/admin/diagnostics to confirm everything is green, then run Scout.",
  }, { status: failed === 0 ? 200 : 500 });
}
