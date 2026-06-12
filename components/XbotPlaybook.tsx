"use client";

import { useState } from "react";
import type { PlaybookItem } from "@/lib/xbot/playbook";

/** One-time account-setup checklist (the "0 followers" prerequisites). Completion is
 *  persisted in xbot_settings.setupChecklist so progress survives across sessions
 *  and the overview page can nag until it's done. */
export default function XbotPlaybook({ items, initialDone }: { items: PlaybookItem[]; initialDone: string[] }) {
  const [done, setDone] = useState<Set<string>>(() => new Set(initialDone));
  const [err, setErr] = useState<string | null>(null);

  async function toggle(id: string) {
    const next = new Set(done);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDone(next);
    setErr(null);
    try {
      const res = await fetch("/api/xbot/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupChecklist: JSON.stringify([...next]) }),
      });
      const json = await res.json();
      if (!json.ok) setErr(json.error ?? "save failed");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="rounded-lg border border-neutral-800 p-3">
      <h3 className="mb-1 text-sm font-medium text-neutral-400">
        Account setup — do this before expecting any post to work ({done.size}/{items.length})
      </h3>
      <p className="mb-3 text-xs text-neutral-500">
        With 0 followers even great content goes nowhere; these are the prerequisites.
      </p>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id}>
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox" checked={done.has(item.id)} onChange={() => toggle(item.id)}
                className="mt-0.5"
              />
              <span className="text-sm">
                <span className={done.has(item.id) ? "text-neutral-500 line-through" : "text-neutral-200"}>
                  {item.label}
                </span>
                <span className="block text-xs text-neutral-500">{item.detail}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
    </div>
  );
}
