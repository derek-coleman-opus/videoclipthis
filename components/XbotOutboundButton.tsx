"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** "Reply guy" trigger: reads your target roster's recent original posts (no @-tag to you
 *  required) and drafts a useful reply to each one's freshest post into the review queue. */
export default function XbotOutboundButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch("/api/xbot/outbound", { method: "POST" });
      const json = await res.json();
      if (!json.ok) {
        setErr(json.error ?? "failed");
        return;
      }
      setMsg(
        json.drafted === 0
          ? `Read ${json.checked} timeline(s) — no fresh posts to reply to right now.`
          : `Read ${json.checked} timeline(s) — ${json.drafted} reply(ies) drafted to the queue.`,
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
          ? "Needs the XBOT_* X credentials — timelines are read in user context"
          : "Read your target roster's fresh posts and draft a useful reply to each"}
        className="rounded-md border border-neutral-600 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
      >
        {busy ? "Drafting…" : "Draft replies to targets"}
      </button>
      {msg && <span className="text-xs text-green-400">{msg}</span>}
      {err && <span className="text-xs text-red-400">{err}</span>}
    </span>
  );
}
