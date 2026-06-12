"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** On-demand drafting controls for the queue page: paste a tweet to get a reply draft,
 *  or generate original-post variants from voice notes. */
export default function XbotGenerate() {
  const router = useRouter();
  const [tweetUrl, setTweetUrl] = useState("");
  const [tweetText, setTweetText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function generate(kind: "reply" | "post") {
    setBusy(kind);
    setErr(null);
    try {
      const body = kind === "reply" ? { kind, tweetUrl, tweetText } : { kind };
      const res = await fetch("/api/xbot/drafts/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.ok) {
        setErr(json.error ?? "failed");
        return;
      }
      if (kind === "reply") { setTweetUrl(""); setTweetText(""); }
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const input = "rounded bg-neutral-800 px-2 py-1 text-sm placeholder:text-neutral-600";

  return (
    <div className="mb-6 rounded-lg border border-neutral-800 p-3">
      <h3 className="mb-2 text-sm font-medium text-neutral-400">Generate drafts</h3>
      <div className="flex flex-wrap items-start gap-2">
        <input
          className={`${input} w-80`} placeholder="Tweet URL (x.com/handle/status/…)"
          value={tweetUrl} onChange={(e) => setTweetUrl(e.target.value)}
        />
        <textarea
          className={`${input} w-96`} rows={2} placeholder="Paste the tweet's text"
          value={tweetText} onChange={(e) => setTweetText(e.target.value)}
        />
        <button
          onClick={() => generate("reply")} disabled={!!busy || !tweetUrl.trim() || !tweetText.trim()}
          className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black hover:bg-neutral-200 disabled:opacity-50"
        >
          {busy === "reply" ? "Drafting…" : "Draft reply"}
        </button>
        <button
          onClick={() => generate("post")} disabled={!!busy}
          className="rounded-md border border-neutral-600 px-3 py-1.5 text-sm font-medium text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy === "post" ? "Drafting…" : "Draft original post (3 variants)"}
        </button>
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        Reply drafts react to the pasted tweet (funny, contrarian, or value-adding — never generic praise);
        post drafts open with a number or a take, document your mission, and come with a media suggestion.
        Both source from your voice notes + mission (XBot Settings).
      </p>
      {err && <p className="mt-1 text-xs text-red-400">{err}</p>}
    </div>
  );
}
