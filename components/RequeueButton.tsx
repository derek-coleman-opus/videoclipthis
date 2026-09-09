"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Revive candidates whose render submit failed without ever being billed.
 *
 *  Renders NOTHING when there is nothing stranded — this is a recovery control, not furniture, and
 *  a permanent zero-state button invites clicking it to see what happens. It spends money, so the
 *  count and that fact are both stated before the confirm. */
export default function RequeueButton({ count }: { count: number }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  if (count <= 0) return null;

  async function requeue() {
    const ok = window.confirm(
      `Requeue ${count} stranded candidate${count === 1 ? "" : "s"}?\n\n`
      + `Each one becomes a PAID OpusClip render on the next Scout run — roughly 1 credit per `
      + `minute of source video.\n\n`
      + `Only candidates that were never billed are affected (no OpusClip project was ever `
      + `created for them), so this cannot double-charge you.`,
    );
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/requeue", { method: "POST" });
      const json = await res.json();
      setMsg(json.ok ? `Requeued ${json.requeued} — now hit “Run Scout now”.` : `Error: ${json.error}`);
      router.refresh();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={requeue}
        disabled={busy}
        className="rounded-md border border-amber-700 bg-amber-950/60 px-3 py-1.5 text-sm font-medium text-amber-200 hover:bg-amber-900/60 disabled:opacity-50"
      >
        {busy ? "Requeueing…" : `Requeue ${count} stranded render${count === 1 ? "" : "s"}`}
      </button>
      {msg && <span className="text-xs text-neutral-400">{msg}</span>}
    </div>
  );
}
