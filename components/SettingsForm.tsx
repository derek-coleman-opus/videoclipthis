"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Initial = { paused: boolean; threshold: number; autonomy: string };

export default function SettingsForm({ initial }: { initial: Initial }) {
  const [paused, setPaused] = useState(initial.paused);
  const [threshold, setThreshold] = useState(initial.threshold);
  const [autonomy, setAutonomy] = useState(initial.autonomy);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const router = useRouter();

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused, threshold: Number(threshold), autonomy }),
      });
      setSaved(true);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-md space-y-4">
      <label className="flex items-center justify-between">
        <span>Paused</span>
        <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
      </label>
      <label className="flex items-center justify-between gap-4">
        <span>Clip-worthiness threshold</span>
        <input
          type="number" min={0} max={100} value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          className="w-20 rounded bg-neutral-800 px-2 py-1 text-right"
        />
      </label>
      <label className="flex items-center justify-between gap-4">
        <span>Autonomy</span>
        <select
          value={autonomy} onChange={(e) => setAutonomy(e.target.value)}
          className="rounded bg-neutral-800 px-2 py-1"
        >
          <option value="review">review (queue all)</option>
          <option value="assisted">assisted</option>
          <option value="auto">auto-post</option>
        </select>
      </label>
      <button
        onClick={save} disabled={saving}
        className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black hover:bg-neutral-200 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save"}
      </button>
      {saved && <span className="ml-3 text-xs text-green-400">Saved</span>}
    </div>
  );
}
