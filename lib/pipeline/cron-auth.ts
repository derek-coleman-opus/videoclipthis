import { NextRequest, NextResponse } from "next/server";

/** Fail-closed cron auth. Cron routes trigger spend (Claude, OpusClip, X writes), so an
 *  unset CRON_SECRET must reject every request — not leave the endpoints world-triggerable.
 *  Returns the error response to send, or null when the request is authorized. */
export function cronAuthError(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured — cron routes fail closed until it is set" },
      { status: 503 },
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
