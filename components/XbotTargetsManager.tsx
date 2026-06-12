"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type TargetRow = {
  id: number;
  handle: string;
  displayName: string;
  bio: string;
  followers: number;
  score: number | null;
  source: string;
  status: string;
  repliesSent: number;
  engagedBack: boolean;
};

type SeedRow = {
  id: number;
  handle: string;
  active: boolean;
};

export default function XbotTargetsManager({ targets, seeds }: { targets: TargetRow[]; seeds: SeedRow[] }) {
  const router = useRouter();
  const [handle, setHandle] = useState("");
  const [bio, setBio] = useState("");
  const [followers, setFollowers] = useState("");
  const [seedHandle, setSeedHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function post(url: string, body: unknown) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.ok) {
        setErr(json.error ?? "failed");
        return false;
      }
      router.refresh();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addTarget() {
    if (!handle.trim()) { setErr("@handle is required"); return; }
    const ok = await post("/api/xbot/targets", {
      handle, bio, followers: Number(followers) || 0,
    });
    if (ok) { setHandle(""); setBio(""); setFollowers(""); }
  }

  async function addSeed() {
    if (!seedHandle.trim()) { setErr("seed @handle is required"); return; }
    if (await post("/api/xbot/seeds", { handle: seedHandle })) setSeedHandle("");
  }

  async function setStatus(id: number, status: string) {
    setBusy(true);
    try {
      await fetch(`/api/xbot/targets/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function toggleSeed(id: number, active: boolean) {
    setBusy(true);
    try {
      await fetch("/api/xbot/seeds", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, active }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const input = "rounded bg-neutral-800 px-2 py-1 text-sm placeholder:text-neutral-600";

  return (
    <div className="space-y-8">
      <section>
        <h3 className="mb-2 text-sm font-medium text-neutral-400">Targets ({targets.length})</h3>
        <p className="mb-3 text-xs text-neutral-500">
          Builders to engage with. Add manually now; keyword/seed discovery fills this automatically once the X API is connected.
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input className={`${input} w-36`} placeholder="@handle" value={handle} onChange={(e) => setHandle(e.target.value)} />
          <input className={`${input} w-72`} placeholder="Bio (paste, optional — helps drafting)" value={bio} onChange={(e) => setBio(e.target.value)} />
          <input className={`${input} w-24`} placeholder="Followers" value={followers} onChange={(e) => setFollowers(e.target.value)} />
          <button
            onClick={addTarget} disabled={busy}
            className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black hover:bg-neutral-200 disabled:opacity-50"
          >
            {busy ? "…" : "Add target"}
          </button>
          {err && <span className="text-xs text-red-400">{err}</span>}
        </div>

        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-neutral-400">
              <tr>
                <th className="p-2 font-medium">@</th>
                <th className="p-2 font-medium">Bio</th>
                <th className="p-2 font-medium">Followers</th>
                <th className="p-2 font-medium">Score</th>
                <th className="p-2 font-medium">Source</th>
                <th className="p-2 font-medium">Status</th>
                <th className="p-2 font-medium">Replies</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {targets.map((t) => (
                <tr key={t.id}>
                  <td className="p-2">
                    <a href={`https://x.com/${t.handle}`} target="_blank" rel="noreferrer" className="hover:underline">
                      @{t.handle}
                    </a>
                    {t.engagedBack && <span className="ml-1 text-xs text-green-400" title="engaged back">↩</span>}
                  </td>
                  <td className="max-w-xs truncate p-2 text-neutral-400" title={t.bio}>{t.bio || "—"}</td>
                  <td className="p-2">{t.followers || "—"}</td>
                  <td className="p-2">{t.score ?? "—"}</td>
                  <td className="p-2 text-neutral-400">{t.source}</td>
                  <td className="p-2">{t.status}</td>
                  <td className="p-2">{t.repliesSent}</td>
                  <td className="p-2 text-right">
                    {t.status !== "archived" ? (
                      <button onClick={() => setStatus(t.id, "archived")} disabled={busy} className="text-xs text-neutral-500 hover:text-red-400 disabled:opacity-50">
                        archive
                      </button>
                    ) : (
                      <button onClick={() => setStatus(t.id, "active")} disabled={busy} className="text-xs text-neutral-500 hover:text-green-400 disabled:opacity-50">
                        restore
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {targets.length === 0 && (
                <tr><td colSpan={8} className="p-3 text-neutral-500">No targets yet — add a builder above.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium text-neutral-400">Seed accounts ({seeds.length})</h3>
        <p className="mb-3 text-xs text-neutral-500">
          Known build-in-public accounts whose repliers get mined as target candidates (needs X API Basic tier).
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input className={`${input} w-36`} placeholder="@handle" value={seedHandle} onChange={(e) => setSeedHandle(e.target.value)} />
          <button
            onClick={addSeed} disabled={busy}
            className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black hover:bg-neutral-200 disabled:opacity-50"
          >
            {busy ? "…" : "Add seed"}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {seeds.map((s) => (
            <span key={s.id} className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${s.active ? "border-neutral-700" : "border-neutral-800 text-neutral-600"}`}>
              @{s.handle}
              <button onClick={() => toggleSeed(s.id, !s.active)} disabled={busy} className="text-neutral-500 hover:text-white disabled:opacity-50">
                {s.active ? "pause" : "resume"}
              </button>
            </span>
          ))}
          {seeds.length === 0 && <span className="text-xs text-neutral-500">No seeds yet.</span>}
        </div>
      </section>
    </div>
  );
}
