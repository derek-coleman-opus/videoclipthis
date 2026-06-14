"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Posted-page action for the traction pro-tip: draft a self-reply with the product
 *  link under one of our own posted tweets, converting impressions into visitors.
 *  The draft lands in the review queue like everything else. */
export default function XbotPlugButton({ draftId }: { draftId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function plug() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/xbot/drafts/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "plug", draftId }),
      });
      const json = await res.json();
      if (!json.ok) {
        setErr(json.error ?? "failed");
        return;
      }
      setDone(true);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) return <span className="text-xs text-green-400">plug drafted → queue</span>;
  return (
    <span>
      <button
        onClick={plug} disabled={busy}
        title="Got traction? Draft a self-reply linking your product to turn the impressions into visitors."
        className="rounded border border-neutral-600 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
      >
        {busy ? "…" : "Plug product"}
      </button>
      {err && <span className="ml-2 text-xs text-red-400">{err}</span>}
    </span>
  );
}
