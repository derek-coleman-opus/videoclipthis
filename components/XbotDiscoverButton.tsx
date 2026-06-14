"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Autonomous discovery trigger: searches your niche keywords (XBot Settings) and auto-adds
 *  good niche creators to the Targets roster as candidates, which the outbound loop engages. */
export default function XbotDiscoverButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch("/api/xbot/discover", { method: "POST" });
      const json = await res.json();
      if (!json.ok) {
        setErr(json.error ?? "failed");
        return;
      }
      setMsg(
        json.rosterFull
          ? "Roster is full — discovery is idle. Archive targets to make room."
          : json.added === 0
            ? `Searched ${json.searched}, scored ${json.evaluated} — no new creators cleared the bar.`
            : `Added ${json.added} new target(s) from ${json.evaluated} scored.`,
      );
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2">
      <button
        onClick={run} disabled={busy || disabled}
        title={disabled
          ? "Needs the XBOT_* X credentials — search runs in user context"
          : "Search your niche keywords and auto-add good creators to the roster"}
        className="rounded-md border border-neutral-600 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
      >
        {busy ? "Discovering…" : "Discover targets"}
      </button>
      {msg && <span className="text-xs text-green-400">{msg}</span>}
      {err && <span className="text-xs text-red-400">{err}</span>}
    </span>
  );
}
