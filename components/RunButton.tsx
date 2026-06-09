"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function RunButton() {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  async function run() {
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch("/api/run", { method: "POST" });
      const json = await res.json();
      setMsg(
        json.ok
          ? `Found ${json.found}, posted ${json.posted}, queued ${json.queued}, skipped ${json.skipped}${json.mock ? " (mock)" : ""}`
          : `Error: ${json.error}`,
      );
      router.refresh();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={run}
        disabled={loading}
        className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black hover:bg-neutral-200 disabled:opacity-50"
      >
        {loading ? "Running…" : "Run Scout now"}
      </button>
      {msg && <span className="text-xs text-neutral-400">{msg}</span>}
    </div>
  );
}
