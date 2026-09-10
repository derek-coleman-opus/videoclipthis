"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Per-row override on /found: push a candidate the scorer skipped into the render pipeline.
 *
 *  Only offered for rows that are actually stuck (skipped/held/failed/found) and never billed.
 *  A row already rendering or posted has nothing to force and forcing it would risk a second
 *  charge, so the button is not rendered at all rather than shown and rejected. */
export default function ForceButton({
  id, title, score, status, hasProject,
}: { id: number; title: string; score: number | null; status: string; hasProject: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  const forceable = !hasProject && ["skipped", "held", "failed", "found", "scored"].includes(status);
  if (!forceable) return null;

  async function force() {
    const ok = window.confirm(
      `Force "${title}"?\n\n`
      + `It scored ${score ?? "?"} and was ${status}. Forcing it renders and posts it anyway, `
      + `bypassing both the score threshold and the editorial veto.\n\n`
      + `This is a PAID OpusClip render (roughly 1 credit per minute of source video).`,
    );
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/force", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const json = await res.json();
      setMsg(json.ok ? "queued — Run Scout now" : `Error: ${json.error}`);
      router.refresh();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <button
        onClick={force}
        disabled={busy}
        className="rounded border border-amber-700 bg-amber-950/60 px-2 py-0.5 text-xs font-medium text-amber-200 hover:bg-amber-900/60 disabled:opacity-50"
      >
        {busy ? "…" : "Force"}
      </button>
      {msg && <span className="text-xs text-neutral-500">{msg}</span>}
    </span>
  );
}
