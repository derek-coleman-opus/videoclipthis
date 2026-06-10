import { NextResponse } from "next/server";
import { runScout } from "@/lib/pipeline/runScout";

export const dynamic = "force-dynamic";
// Hobby caps functions at 60s; on Vercel Pro raise to 300 — the full clip pipeline needs it.
export const maxDuration = 60;

// Manual "Run Scout now" trigger from the admin panel (force ignores the paused flag).
export async function POST() {
  try {
    const result = await runScout({ force: true });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
