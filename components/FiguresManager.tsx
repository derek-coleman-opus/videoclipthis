"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Row = {
  id: number;
  name: string;
  xHandle: string;
  org: string;
  priority: number;
  clipped: number;
};

export default function FiguresManager({ figures }: { figures: Row[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [org, setOrg] = useState("");
  const [priority, setPriority] = useState(2);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    if (!name.trim() || !handle.trim()) {
      setErr("name and @handle are required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/figures", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, xHandle: handle, org, priority }),
      });
      const json = await res.json();
      if (!json.ok) {
        setErr(json.error ?? "failed");
        return;
      }
      setName(""); setHandle(""); setOrg(""); setPriority(2);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setBusy(true);
    try {
      await fetch(`/api/figures/${id}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const input = "rounded bg-neutral-800 px-2 py-1 text-sm placeholder:text-neutral-600";

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input className={`${input} w-44`} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={`${input} w-36`} placeholder="@handle" value={handle} onChange={(e) => setHandle(e.target.value)} />
        <input className={`${input} w-40`} placeholder="Org (optional)" value={org} onChange={(e) => setOrg(e.target.value)} />
        <select className={input} value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
          <option value={1}>P1</option>
          <option value={2}>P2</option>
          <option value={3}>P3</option>
        </select>
        <button
          onClick={add} disabled={busy}
          className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black hover:bg-neutral-200 disabled:opacity-50"
        >
          {busy ? "…" : "Add figure"}
        </button>
        {err && <span className="text-xs text-red-400">{err}</span>}
      </div>

      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-left text-neutral-400">
            <tr>
              <th className="p-2 font-medium">Figure</th>
              <th className="p-2 font-medium">@</th>
              <th className="p-2 font-medium">Org</th>
              <th className="p-2 font-medium">Priority</th>
              <th className="p-2 font-medium">Clipped</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {figures.map((f) => (
              <tr key={f.id}>
                <td className="p-2">{f.name}</td>
                <td className="p-2 text-neutral-400">@{f.xHandle}</td>
                <td className="p-2 text-neutral-400">{f.org || "—"}</td>
                <td className="p-2">{f.priority}</td>
                <td className="p-2">{f.clipped}</td>
                <td className="p-2 text-right">
                  <button onClick={() => remove(f.id)} disabled={busy} className="text-xs text-neutral-500 hover:text-red-400 disabled:opacity-50">
                    remove
                  </button>
                </td>
              </tr>
            ))}
            {figures.length === 0 && (
              <tr><td colSpan={6} className="p-3 text-neutral-500">No figures yet — add one above.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
