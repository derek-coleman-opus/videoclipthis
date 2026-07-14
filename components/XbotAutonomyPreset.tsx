"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "paused" | "review" | "assisted" | "autopilot" | "growth";

/** One-click autonomy control. Each preset patches xbot_settings via the existing endpoint.
 *  Growth autopilot sets the volume knobs to the code-side hard maxima (80 likes/day,
 *  20 replies/day — the 250/day version of this preset got the account LOCKED) and a 16h
 *  active window (quiet 05:00-13:00 UTC ≈ US day + evening). On top of these, the server
 *  ramps caps up over the first three weeks and throttles after any lock. */
const PRESETS: Record<Exclude<Mode, "paused">, Record<string, unknown>> = {
  review: { paused: false, replyAutonomy: "review", postAutonomy: "review" },
  assisted: { paused: false, replyAutonomy: "auto", postAutonomy: "review", likesAuto: true },
  autopilot: { paused: false, replyAutonomy: "auto", postAutonomy: "auto", likesAuto: true },
  growth: {
    paused: false, replyAutonomy: "auto", postAutonomy: "auto", likesAuto: true,
    dailyLikeCap: 80, dailyReplyCap: 20, dailyEngageCap: 30, dailyPostCap: 4,
    quietStartUtc: 5, quietEndUtc: 13,
  },
};

export default function XbotAutonomyPreset({
  paused, replyAutonomy, postAutonomy, dailyLikeCap,
}: { paused: boolean; replyAutonomy: string; postAutonomy: string; dailyLikeCap: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const current: Mode = paused ? "paused"
    : replyAutonomy === "auto" && postAutonomy === "auto" && dailyLikeCap >= 80 ? "growth"
    : replyAutonomy === "auto" && postAutonomy === "auto" ? "autopilot"
    : replyAutonomy === "auto" ? "assisted"
    : "review";

  async function apply(mode: Mode) {
    setBusy(mode);
    setErr(null);
    try {
      const patch = mode === "paused" ? { paused: true } : PRESETS[mode];
      const res = await fetch("/api/xbot/settings", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
      });
      const json = await res.json();
      if (!json.ok) { setErr(json.error ?? "failed"); return; }
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const options: { mode: Mode; label: string; hint: string }[] = [
    { mode: "review", label: "Review", hint: "Draft everything, you approve each one" },
    { mode: "assisted", label: "Assisted+", hint: "Auto-like + auto-reply to others; your posts wait for approval" },
    { mode: "autopilot", label: "Autopilot", hint: "Everything posts unattended (safety-gated)" },
    { mode: "growth", label: "🚀 Growth autopilot", hint: "Autopilot + max safe volume: up to 80 likes/day, 20 replies/day (auto-ramped), 16h active window" },
    { mode: "paused", label: "⏸ Pause", hint: "Stop all engagement now" },
  ];

  return (
    <div className="mb-6 rounded-lg border border-neutral-800 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-medium text-neutral-400">Autonomy</span>
        <span className="text-xs text-neutral-500">— current: <b className="text-neutral-300">{labelFor(current)}</b></span>
      </div>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const active = current === o.mode;
          return (
            <button
              key={o.mode} onClick={() => apply(o.mode)} disabled={!!busy || active}
              title={o.hint}
              className={`rounded-md px-3 py-1.5 text-sm ${
                active
                  ? "bg-white font-medium text-black"
                  : o.mode === "paused"
                    ? "border border-amber-700 text-amber-300 hover:bg-amber-900/30"
                    : "border border-neutral-600 text-neutral-200 hover:bg-neutral-800"
              } disabled:opacity-60`}
            >
              {busy === o.mode ? "…" : o.label}
            </button>
          );
        })}
        {err && <span className="self-center text-xs text-red-400">{err}</span>}
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        {options.find((o) => o.mode === current)?.hint}
      </p>
    </div>
  );
}

function labelFor(m: Mode): string {
  return m === "paused" ? "Paused"
    : m === "assisted" ? "Assisted+"
    : m === "autopilot" ? "Autopilot"
    : m === "growth" ? "Growth autopilot"
    : "Review";
}
