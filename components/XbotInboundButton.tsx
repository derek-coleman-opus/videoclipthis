"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** "Reply to everyone who engages" trigger: pulls new mentions (comments on our posts,
 *  answers to our replies) and queues an engage-back draft for each into the review queue. */
export default function XbotInboundButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch("/api/xbot/inbound", { method: "POST" });
      const json = await res.json();
      if (!json.ok) {
        setErr(json.error ?? "failed");
        return;
      }
      setMsg(
        json.found === 0
          ? "No new engagement since last check."
          : `${json.found} new engager(s) — ${json.drafted} engage-back(s) drafted to the queue.`,
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
        onClick={check} disabled={busy || disabled}
        title={disabled
          ? "Needs the XBOT_* X credentials — mentions are read in user context"
          : "Fetch new comments on your posts/replies and draft an engage-back for each"}
        className="rounded-md border border-neutral-600 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
      >
        {busy ? "Checking…" : "Check inbound engagement"}
      </button>
      {msg && <span className="text-xs text-green-400">{msg}</span>}
      {err && <span className="text-xs text-red-400">{err}</span>}
    </span>
  );
}
