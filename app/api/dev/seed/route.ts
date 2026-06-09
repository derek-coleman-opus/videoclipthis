import { NextResponse } from "next/server";
import { seedDemo } from "@/lib/seed";

export const dynamic = "force-dynamic";

// Loads demo activity so the panel is alive without keys. Protected by admin basic-auth (middleware).
export async function POST() {
  try {
    await seedDemo();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
