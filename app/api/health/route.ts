import { NextRequest, NextResponse } from "next/server";
import { computeHealth } from "@/lib/pipeline/health";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** READ-ONLY health, authenticated by HEALTH_TOKEN rather than the admin password.
 *
 *  Exists so the pipeline's state can be WATCHED from outside without handing over admin access.
 *  Every outage in this project was found days late because the only way to see the system was to
 *  log into the admin by hand; a pollable endpoint means a stall announces itself instead.
 *
 *  Deliberately narrow: it returns the health verdict, counters and the pipeline's own error
 *  messages. No environment values, no credentials, no post content, and no ability to change
 *  anything — a leaked token exposes operational state, never control and never secrets.
 *
 *  Auth is constant-time-ish and fails closed: with HEALTH_TOKEN unset the endpoint is disabled
 *  outright rather than served open, so forgetting to configure it can never publish state. */
export async function GET(req: NextRequest) {
  const expected = process.env.HEALTH_TOKEN?.trim();
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "HEALTH_TOKEN is not configured — health endpoint disabled" },
      { status: 503 },
    );
  }
  const provided =
    req.nextUrl.searchParams.get("token") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (provided !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const health = await computeHealth();
    // 200 regardless of verdict: a monitor needs to read WHY it is unhealthy, and a non-2xx would
    // make some pollers discard the body that carries the answer.
    return NextResponse.json(health);
  } catch (e) {
    return NextResponse.json(
      { ok: false, stalled: true, error: `health check itself failed: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
