"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Draft = {
  id: number;
  kind: string;
  contextText: string;
  text: string;
  rationale: string;
  inReplyToTweetId: string | null;
  authorHandle?: string | null;
};

const MAX_CHARS = 270;

export default function XbotDraftCard({ draft }: { draft: Draft }) {
  const router = useRouter();
  const [text, setText] = useState(draft.text);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function act(action: "approve" | "reject") {
    setBusy(action);
    setErr(null);
    setNote(null);
    try {
      const res = await fetch("/api/xbot/drafts/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: draft.id, action, text }),
      });
      const json = await res.json();
      if (!json.ok) {
        setErr(json.error ?? "failed");
      } else if (json.note) {
        setNote(json.note);
      }
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const over = text.length > MAX_CHARS;

  return (
    <div className="rounded-lg border border-neutral-800 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-neutral-500">
        <span className="rounded bg-neutral-800 px-1.5 py-0.5 uppercase">{draft.kind}</span>
        {draft.inReplyToTweetId && (
          <a
            href={`https://x.com/${draft.authorHandle ?? "i"}/status/${draft.inReplyToTweetId}`}
            target="_blank" rel="noreferrer" className="hover:underline"
          >
            view original tweet ↗
          </a>
        )}
      </div>
      {draft.contextText && (
        <blockquote className="mb-2 border-l-2 border-neutral-700 pl-2 text-sm text-neutral-400">
          {draft.contextText}
        </blockquote>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className="w-full rounded bg-neutral-800 p-2 text-sm"
      />
      <div className="mt-1 flex items-center justify-between">
        <span className={`text-xs ${over ? "text-red-400" : "text-neutral-500"}`}>
          {text.length}/{MAX_CHARS}
        </span>
        {draft.rationale && <span className="max-w-md truncate text-xs text-neutral-600" title={draft.rationale}>{draft.rationale}</span>}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => act("approve")} disabled={!!busy || over || !text.trim()}
          className="rounded bg-green-700 px-2 py-0.5 text-xs text-white hover:bg-green-600 disabled:opacity-50"
        >
          {busy === "approve" ? "…" : "Approve"}
        </button>
        <button
          onClick={() => act("reject")} disabled={!!busy}
          className="rounded bg-neutral-700 px-2 py-0.5 text-xs text-white hover:bg-neutral-600 disabled:opacity-50"
        >
          {busy === "reject" ? "…" : "Reject"}
        </button>
        {err && <span className="text-xs text-red-400">{err}</span>}
        {note && <span className="text-xs text-amber-300">{note}</span>}
      </div>
    </div>
  );
}
