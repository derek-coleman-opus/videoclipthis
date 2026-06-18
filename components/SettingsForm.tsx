"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Initial = {
  paused: boolean; threshold: number; autonomy: string;
  niche: string; watchChannels: string; opusBrandTemplateId: string; searchTopics: string;
};

export default function SettingsForm({ initial }: { initial: Initial }) {
  const [paused, setPaused] = useState(initial.paused);
  const [threshold, setThreshold] = useState(initial.threshold);
  const [autonomy, setAutonomy] = useState(initial.autonomy);
  const [niche, setNiche] = useState(initial.niche);
  const [watchChannels, setWatchChannels] = useState(initial.watchChannels);
  const [opusBrandTemplateId, setOpusBrandTemplateId] = useState(initial.opusBrandTemplateId);
  const [searchTopics, setSearchTopics] = useState(initial.searchTopics);
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
        body: JSON.stringify({ paused, threshold: Number(threshold), autonomy, niche, watchChannels, opusBrandTemplateId, searchTopics }),
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
      <label className="block">
        <span className="mb-1 block">Niche <span className="text-xs text-neutral-500">(the audience Claude scores clip-worthiness for — change it to fitness, travel, finance…)</span></span>
        <input
          type="text" value={niche} onChange={(e) => setNiche(e.target.value)}
          className="w-full rounded bg-neutral-800 px-2 py-1 text-sm"
          placeholder="AI / developer tooling"
        />
      </label>
      <label className="block">
        <span className="mb-1 block">Watched channels <span className="text-xs text-neutral-500">(one per line: Name | youtubeHandle — handle optional; empty = built-in defaults. Track <em>people</em> on the Figures page.)</span></span>
        <textarea
          rows={5} value={watchChannels} onChange={(e) => setWatchChannels(e.target.value)}
          className="w-full rounded bg-neutral-800 p-2 text-sm font-mono"
          placeholder={"Anthropic | anthropic-ai\nGoogle DeepMind | Google_DeepMind"}
        />
      </label>
      <label className="block">
        <span className="mb-1 block">Search topics <span className="text-xs text-neutral-500">(one keyword/phrase per line — the bot searches YouTube for fresh long-form on these, beyond the channel list; blank = built-in AI defaults)</span></span>
        <textarea
          rows={5} value={searchTopics} onChange={(e) => setSearchTopics(e.target.value)}
          className="w-full rounded bg-neutral-800 p-2 text-sm font-mono"
          placeholder={"AI agents\nLLM evals\ncoding agents\nopen source models"}
        />
      </label>
      <label className="block">
        <span className="mb-1 block">OpusClip brand template <span className="text-xs text-neutral-500">(the template id that sets vertical layout + caption style — fixes slide framing. List yours at <code>/api/debug/brand-templates</code>; blank = account default.)</span></span>
        <input
          type="text" value={opusBrandTemplateId} onChange={(e) => setOpusBrandTemplateId(e.target.value)}
          className="w-full rounded bg-neutral-800 px-2 py-1 text-sm font-mono"
          placeholder="(account default)"
        />
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
