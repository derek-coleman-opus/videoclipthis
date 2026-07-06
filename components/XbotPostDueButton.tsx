"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Run the autonomy engine on demand: post auto-eligible drafts (safety-gated, paced) and
 *  auto-like. Useful for testing without waiting for the 15-min cron. */
export default function XbotPostDueButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch("/api/xbot/post-due", { method: "POST" });
      const json = await res.json();
      if (!json.ok) { setErr(json.error ?? "failed"); return; }
      setMsg(
        json.skipped
          ? `Idle: ${json.skipped}.`
          : `Posted ${json.posted}, held ${json.held}, liked ${json.liked}.`,
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
          ? "Needs the XBOT_* X credentials to post"
          : "Post the auto-eligible drafts now (safety-gated) and run auto-likes"}
        className="rounded-md border border-neutral-600 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
      >
        {busy ? "Posting…" : "Post due now"}
      </button>
      {msg && <span className="text-xs text-green-400">{msg}</span>}
      {err && <span className="text-xs text-red-400">{err}</span>}
    </span>
  );
}
