"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Initial = {
  paused: boolean;
  replyAutonomy: string;
  postAutonomy: string;
  likesAuto: boolean;
  dailyReplyCap: number;
  dailyLikeCap: number;
  dailyPostCap: number;
  dailyEngageCap: number;
  cooldownDays: number;
  quietStartUtc: number;
  quietEndUtc: number;
  maxFollowers: number;
  keywords: string;     // JSON array string
  voiceNotes: string;
  mission: string;
  productUrl: string;
  communityId: string;
};

export default function XbotSettingsForm({ initial }: { initial: Initial }) {
  const router = useRouter();
  const [form, setForm] = useState(() => ({
    ...initial,
    keywords: prettyKeywords(initial.keywords),
  }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setSaved(false);
    setErr(null);
    try {
      const res = await fetch("/api/xbot/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          keywords: JSON.stringify(form.keywords.split("\n").map((s) => s.trim()).filter(Boolean)),
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        setErr(json.error ?? "failed");
        return;
      }
      setSaved(true);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const num = "w-20 rounded bg-neutral-800 px-2 py-1 text-right";
  const row = "flex items-center justify-between gap-4";

  return (
    <div className="max-w-xl space-y-4">
      <label className={row}>
        <span>Paused <span className="text-xs text-neutral-500">(no engagement runs while on)</span></span>
        <input type="checkbox" checked={form.paused} onChange={(e) => set("paused", e.target.checked)} />
      </label>

      <label className={row}>
        <span>Reply autonomy</span>
        <select value={form.replyAutonomy} onChange={(e) => set("replyAutonomy", e.target.value)} className="rounded bg-neutral-800 px-2 py-1">
          <option value="review">review (approve each reply)</option>
          <option value="auto">auto-post</option>
        </select>
      </label>
      <label className={row}>
        <span>Post autonomy</span>
        <select value={form.postAutonomy} onChange={(e) => set("postAutonomy", e.target.value)} className="rounded bg-neutral-800 px-2 py-1">
          <option value="review">review (approve each post)</option>
          <option value="auto">auto-post</option>
        </select>
      </label>
      <label className={row}>
        <span>Auto-like targets&apos; posts</span>
        <input type="checkbox" checked={form.likesAuto} onChange={(e) => set("likesAuto", e.target.checked)} />
      </label>

      <p className="rounded bg-neutral-900 p-2 text-xs text-neutral-500">
        Per X automation rules, daily caps are also spread out automatically: an hourly cap
        (daily ÷ active hours) plus a minimum gap between consecutive actions (replies 5 min,
        engage-backs 3 min, posts 30 min) — the bot can never burst a day&apos;s budget at once.
      </p>
      <label className={row}>
        <span>Daily reply cap <span className="text-xs text-neutral-500">(method: 15–30)</span></span>
        <input type="number" min={0} className={num} value={form.dailyReplyCap} onChange={(e) => set("dailyReplyCap", Number(e.target.value))} />
      </label>
      <label className={row}>
        <span>Daily like cap</span>
        <input type="number" min={0} className={num} value={form.dailyLikeCap} onChange={(e) => set("dailyLikeCap", Number(e.target.value))} />
      </label>
      <label className={row}>
        <span>Daily post cap <span className="text-xs text-neutral-500">(method: 3–5)</span></span>
        <input type="number" min={0} className={num} value={form.dailyPostCap} onChange={(e) => set("dailyPostCap", Number(e.target.value))} />
      </label>
      <label className={row}>
        <span>Daily engage-back cap <span className="text-xs text-neutral-500">(reply to everyone who comments)</span></span>
        <input type="number" min={0} className={num} value={form.dailyEngageCap} onChange={(e) => set("dailyEngageCap", Number(e.target.value))} />
      </label>
      <label className={row}>
        <span>Reply cooldown per target (days)</span>
        <input type="number" min={0} className={num} value={form.cooldownDays} onChange={(e) => set("cooldownDays", Number(e.target.value))} />
      </label>
      <label className={row}>
        <span>Quiet hours UTC (start–end) <span className="text-xs text-neutral-500">(22–14 ⇒ engage 9am–5pm EST)</span></span>
        <span className="flex gap-1">
          <input type="number" min={0} max={23} className={num} value={form.quietStartUtc} onChange={(e) => set("quietStartUtc", Number(e.target.value))} />
          <input type="number" min={0} max={23} className={num} value={form.quietEndUtc} onChange={(e) => set("quietEndUtc", Number(e.target.value))} />
        </span>
      </label>
      <label className={row}>
        <span>Max followers for targets <span className="text-xs text-neutral-500">(method: &lt;5000)</span></span>
        <input type="number" min={0} className="w-28 rounded bg-neutral-800 px-2 py-1 text-right" value={form.maxFollowers} onChange={(e) => set("maxFollowers", Number(e.target.value))} />
      </label>

      <label className="block">
        <span className="mb-1 block">Mission <span className="text-xs text-neutral-500">(the public storyline every post documents — makes people remember you)</span></span>
        <input
          type="text" value={form.mission} onChange={(e) => set("mission", e.target.value)}
          className="w-full rounded bg-neutral-800 px-2 py-1 text-sm"
          placeholder="e.g. growing videoclipthis from 0 → $1k MRR in public"
        />
      </label>
      <label className="block">
        <span className="mb-1 block">Product URL <span className="text-xs text-neutral-500">(linked in plug replies when a post gets traction)</span></span>
        <input
          type="text" value={form.productUrl} onChange={(e) => set("productUrl", e.target.value)}
          className="w-full rounded bg-neutral-800 px-2 py-1 text-sm"
          placeholder="https://…"
        />
      </label>
      <label className="block">
        <span className="mb-1 block">X community ID <span className="text-xs text-neutral-500">(post originals into one big niche community, e.g. Build in Public — small accounts reach further there; blank = normal timeline)</span></span>
        <input
          type="text" value={form.communityId} onChange={(e) => set("communityId", e.target.value)}
          className="w-full rounded bg-neutral-800 px-2 py-1 text-sm font-mono"
          placeholder="numeric id from x.com/i/communities/<id>"
        />
      </label>

      <label className="block">
        <span className="mb-1 block">Discovery keywords <span className="text-xs text-neutral-500">(one search query per line)</span></span>
        <textarea
          rows={5} value={form.keywords} onChange={(e) => set("keywords", e.target.value)}
          className="w-full rounded bg-neutral-800 p-2 text-sm font-mono"
        />
      </label>

      <label className="block">
        <span className="mb-1 block">Voice notes <span className="text-xs text-neutral-500">(what you&apos;re building, real metrics, milestones — Claude drafts from this)</span></span>
        <textarea
          rows={6} value={form.voiceNotes} onChange={(e) => set("voiceNotes", e.target.value)}
          className="w-full rounded bg-neutral-800 p-2 text-sm"
          placeholder="e.g. Building videoclipthis, an AI clip bot. 412 clips posted, 7.6K impressions last week. I care about shipping fast, hate over-engineering…"
        />
      </label>

      <button
        onClick={save} disabled={saving}
        className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black hover:bg-neutral-200 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save"}
      </button>
      {saved && <span className="ml-3 text-xs text-green-400">Saved</span>}
      {err && <span className="ml-3 text-xs text-red-400">{err}</span>}
    </div>
  );
}

function prettyKeywords(json: string): string {
  try {
    const arr = JSON.parse(json);
    if (Array.isArray(arr)) return arr.join("\n");
  } catch { /* ignore */ }
  return "";
}
