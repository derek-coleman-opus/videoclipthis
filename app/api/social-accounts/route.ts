import { NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { opusclipListSocialAccounts } from "@/lib/pipeline/opusclip";
import { parseCrosspostAccounts } from "@/lib/pipeline/crosspost";

export const dynamic = "force-dynamic";

/** Social accounts connected in the OpusClip dashboard + which ones cross-posting is
 *  enabled for. The admin settings picker renders from this. */
export async function GET() {
  try {
    const settings = await getSettings();
    const enabled = new Set(parseCrosspostAccounts(settings).map((a) => a.postAccountId));
    const accounts = await opusclipListSocialAccounts(
      process.env.OPUSCLIP_API_KEY ?? "",
      process.env.OPUSCLIP_API_BASE ?? "",
    );
    return NextResponse.json({
      ok: true,
      accounts: accounts.map((a) => ({ ...a, enabled: enabled.has(a.postAccountId) })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
