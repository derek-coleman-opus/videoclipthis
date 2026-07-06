"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Review controls for a clip: edit the post text in place, then approve (posts to X now)
 *  or reject. Also shown for "failed" clips (retry after a transient publish error) and
 *  "approved" clips (post now instead of waiting for the paced drain). */
export default function ClipActions({
  id, postText, status,
}: { id: number; postText: string; status: string }) {
  const [text, setText] = useState(postText);
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
        body: JSON.stringify({ id, action, text }),
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

  const over = text.length > 280;
  const approveLabel = status === "failed" ? "Retry post" : status === "approved" ? "Post now" : "Approve & post";

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className="w-full rounded bg-neutral-800 p-2 text-sm"
      />
      <div className="mt-1 flex items-center gap-2">
        <button
          onClick={() => act("approve")} disabled={!!busy || over || !text.trim()}
          className="rounded bg-green-700 px-2 py-0.5 text-xs text-white hover:bg-green-600 disabled:opacity-50"
        >
          {busy === "approve" ? "…" : approveLabel}
        </button>
        <button
          onClick={() => act("reject")} disabled={!!busy}
          className="rounded bg-neutral-700 px-2 py-0.5 text-xs text-white hover:bg-neutral-600 disabled:opacity-50"
        >
          {busy === "reject" ? "…" : "Reject"}
        </button>
        <span className={`text-xs ${over ? "text-red-400" : "text-neutral-600"}`}>{text.length}/280</span>
        {err && <span className="text-xs text-red-400">{err}</span>}
      </div>
    </div>
  );
}
