"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Re-poll renders that were paid for but never collected.
 *
 *  The sibling of RequeueButton, and deliberately styled calmer: requeue SPENDS money (it submits
 *  new renders), this one does not. The OpusClip projects already exist and are already billed —
 *  all this does is put the candidates back in front of the collector. Same zero-state rule: a
 *  recovery control, not furniture. */
export default function RecollectButton({ count }: { count: number }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  if (count <= 0) return null;

  async function recollect() {
    const ok = window.confirm(
      `Re-collect ${count} paid render${count === 1 ? "" : "s"}?\n\n`
      + `These already have an OpusClip project — they were billed, finished, and never `
      + `harvested. Re-collecting re-reads those existing projects.\n\n`
      + `This creates NO new render and costs nothing.`,
    );
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/recollect", { method: "POST" });
      const json = await res.json();
      setMsg(json.ok ? `Re-collecting ${json.recollected} — now hit “Run Scout now”.` : `Error: ${json.error}`);
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
        onClick={recollect}
        disabled={busy}
        className="rounded-md border border-sky-700 bg-sky-950/60 px-3 py-1.5 text-sm font-medium text-sky-200 hover:bg-sky-900/60 disabled:opacity-50"
      >
        {busy ? "Re-collecting…" : `Re-collect ${count} paid render${count === 1 ? "" : "s"} (free)`}
      </button>
      {msg && <span className="text-xs text-neutral-400">{msg}</span>}
    </div>
  );
}
