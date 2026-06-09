"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ClipActions({ id }: { id: number }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  async function act(action: "approve" | "reject") {
    setBusy(action);
    setErr(null);
    try {
      const res = await fetch("/api/clips/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const json = await res.json();
      if (!json.ok) setErr(json.error ?? "failed");
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => act("approve")} disabled={!!busy}
        className="rounded bg-green-700 px-2 py-0.5 text-xs text-white hover:bg-green-600 disabled:opacity-50"
      >
        {busy === "approve" ? "…" : "Approve & post"}
      </button>
      <button
        onClick={() => act("reject")} disabled={!!busy}
        className="rounded bg-neutral-700 px-2 py-0.5 text-xs text-white hover:bg-neutral-600 disabled:opacity-50"
      >
        {busy === "reject" ? "…" : "Reject"}
      </button>
      {err && <span className="text-xs text-red-400">{err}</span>}
    </div>
  );
}
