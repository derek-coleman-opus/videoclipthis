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
  mediaIdea?: string | null;
};

const MAX_CHARS = 270;

const STYLES = [
  { value: "auto", label: "Auto" },
  { value: "funny", label: "Funny" },
  { value: "informative", label: "Informative" },
  { value: "contrarian", label: "Contrarian" },
];

export default function XbotDraftCard({ draft }: { draft: Draft }) {
  const router = useRouter();
  const [text, setText] = useState(draft.text);
  const [rationale, setRationale] = useState(draft.rationale);
  const [mediaIdea, setMediaIdea] = useState(draft.mediaIdea ?? "");
  const [style, setStyle] = useState("auto");
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
        // Keep the error on screen — do NOT refresh (a refresh re-renders and wipes it).
        setErr(json.error ?? "failed");
        return;
      }
      if (json.note) setNote(json.note);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    setBusy("regenerate");
    setErr(null);
    setNote(null);
    try {
      const res = await fetch("/api/xbot/drafts/regenerate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: draft.id, style }),
      });
      const json = await res.json();
      if (!json.ok) {
        setErr(json.error ?? "failed");
        return;
      }
      setText(json.draft.text);
      setRationale(json.draft.rationale ?? "");
      setMediaIdea(json.draft.mediaIdea ?? "");
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
      {mediaIdea && (
        <p className="mt-1 text-xs text-amber-300">
          📸 Attach media when posting (text-only underperforms): {mediaIdea}
        </p>
      )}
      <div className="mt-1 flex items-center justify-between">
        <span className={`text-xs ${over ? "text-red-400" : "text-neutral-500"}`}>
          {text.length}/{MAX_CHARS}
        </span>
        {rationale && <span className="max-w-md truncate text-xs text-neutral-600" title={rationale}>{rationale}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
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
        <span className="ml-2 flex items-center gap-1 border-l border-neutral-800 pl-2">
          <select
            value={style} onChange={(e) => setStyle(e.target.value)} disabled={!!busy}
            className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-200 disabled:opacity-50"
            title="Voice for the regenerated draft"
          >
            {STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <button
            onClick={regenerate} disabled={!!busy}
            className="rounded border border-neutral-600 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
            title="Re-draft this for the same tweet in the chosen style"
          >
            {busy === "regenerate" ? "Regenerating…" : "↻ Regenerate"}
          </button>
        </span>
        {note && <span className="text-xs text-amber-300">{note}</span>}
      </div>
      {err && (
        <p className="mt-2 rounded border border-red-800 bg-red-950/50 p-2 text-xs text-red-300">
          Post failed: {err}
        </p>
      )}
    </div>
  );
}
