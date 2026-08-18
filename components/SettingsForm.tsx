"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Initial = {
  paused: boolean; threshold: number; autonomy: string; dailyClipCap: number;
  niche: string; watchChannels: string; opusBrandTemplateId: string; searchTopics: string;
  activeProfile: string; curationBrief: string;
};

type ProfileOption = { key: string; label: string; topicCount: number; channelCount: number };

export default function SettingsForm({
  initial, profiles,
}: { initial: Initial; profiles: ProfileOption[] }) {
  const [paused, setPaused] = useState(initial.paused);
  const [threshold, setThreshold] = useState(initial.threshold);
  const [autonomy, setAutonomy] = useState(initial.autonomy);
  const [dailyClipCap, setDailyClipCap] = useState(initial.dailyClipCap);
  const [niche, setNiche] = useState(initial.niche);
  const [watchChannels, setWatchChannels] = useState(initial.watchChannels);
  const [opusBrandTemplateId, setOpusBrandTemplateId] = useState(initial.opusBrandTemplateId);
  const [searchTopics, setSearchTopics] = useState(initial.searchTopics);
  const [curationBrief, setCurationBrief] = useState(initial.curationBrief);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const router = useRouter();

  const active = profiles.find((p) => p.key === initial.activeProfile) ?? profiles[0];

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          paused, threshold: Number(threshold), autonomy, dailyClipCap: Number(dailyClipCap),
          niche, watchChannels, opusBrandTemplateId, searchTopics, curationBrief,
        }),
      });
      setSaved(true);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  /** Switching rewrites the fields below, so unsaved edits to them would be silently discarded —
   *  confirm first rather than eating someone's half-typed topic list. */
  async function switchTo(key: string) {
    const to = profiles.find((p) => p.key === key);
    if (!to) return;
    const ok = window.confirm(
      `Switch to "${to.label}"?\n\n`
      + `This replaces the niche, search topics, watched channels, threshold and clip brief below `
      + `with that profile's, and changes what the scorer, the clip curator and the editor all `
      + `optimize for.\n\n`
      + `Your current "${active?.label ?? initial.activeProfile}" settings are saved first, so `
      + `switching back restores them. Unsaved edits on this page are NOT saved — cancel and hit `
      + `Save first if you have any.`,
    );
    if (!ok) return;
    setSwitching(key);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ switchProfile: key }),
      });
      router.refresh();
    } finally {
      setSwitching(null);
    }
  }

  return (
    <div className="max-w-md space-y-4">
      {/* Audience profile — the one control that moves discovery, scoring, clip selection and the
          editorial veto together. Placed first because everything below it is downstream of it. */}
      <div className="rounded-md border border-neutral-800 p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="font-medium">Audience profile</span>
          <span className="text-xs text-neutral-500">what this account is for</span>
        </div>
        <div className="space-y-2">
          {profiles.map((p) => {
            const isActive = p.key === initial.activeProfile;
            return (
              <div
                key={p.key}
                className={`flex items-center justify-between gap-3 rounded px-2 py-1.5 text-sm ${
                  isActive ? "bg-neutral-800" : ""
                }`}
              >
                <span>
                  {isActive && <span className="mr-1.5 text-green-400">●</span>}
                  {p.label}
                  <span className="ml-2 text-xs text-neutral-500">
                    {p.topicCount} topics · {p.channelCount} channels
                  </span>
                </span>
                {isActive ? (
                  <span className="text-xs text-neutral-500">active</span>
                ) : (
                  <button
                    onClick={() => switchTo(p.key)}
                    disabled={switching !== null}
                    className="rounded bg-white px-2 py-1 text-xs font-medium text-black hover:bg-neutral-200 disabled:opacity-50"
                  >
                    {switching === p.key ? "Switching…" : "Switch"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-neutral-500">
          Switching replaces the niche, topics, channels, threshold and clip brief below, and
          re-points the scorer, the clip curator and the editorial veto at that audience. Your
          current profile&apos;s values are saved first, so switching back restores them.
          <br />
          <b>Tracked figures are shared across profiles</b> — clear them on the Figures page when
          switching lanes, or the old lane keeps leaking into search.
        </p>
      </div>
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
          value={autonomy === "assisted" ? "review" : autonomy}
          onChange={(e) => setAutonomy(e.target.value)}
          className="rounded bg-neutral-800 px-2 py-1"
        >
          <option value="review">review (queue all)</option>
          <option value="auto">auto-post (capped + paced)</option>
        </select>
      </label>
      <label className="flex items-center justify-between gap-4">
        <span>Daily clip cap <span className="text-xs text-neutral-500">(max auto-posts/day)</span></span>
        <input
          type="number" min={0} max={48} value={dailyClipCap}
          onChange={(e) => setDailyClipCap(Number(e.target.value))}
          className="w-20 rounded bg-neutral-800 px-2 py-1 text-right"
        />
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
        <span className="mb-1 block">Watched channels <span className="text-xs text-neutral-500">(one per line: Name | youtubeHandle | xHandle — handles optional; the X handle lets posts tag the brand (&quot;via @…&quot;). Empty = built-in defaults. Track <em>people</em> on the Figures page.)</span></span>
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
        <span className="mb-1 block">Clip brief <span className="text-xs text-neutral-500">(what moment to cut out of each video — the single biggest lever on whether clips get shared, since it decides the 30 seconds people actually see. Blank = the active profile&apos;s brief.)</span></span>
        <textarea
          rows={6} value={curationBrief} onChange={(e) => setCurationBrief(e.target.value)}
          className="w-full rounded bg-neutral-800 p-2 text-sm"
          placeholder={`(using the ${active?.label ?? "profile"} brief — paste your own here to override)`}
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
