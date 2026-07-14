"use client";

import { useEffect, useState } from "react";

interface AccountRow {
  postAccountId: string;
  subAccountId: string | null;
  platform: string;
  name: string;
  enabled: boolean;
}

const PLATFORM_LABEL: Record<string, string> = {
  YOUTUBE: "YouTube",
  TIKTOK_BUSINESS: "TikTok",
  INSTAGRAM_BUSINESS: "Instagram",
  FACEBOOK_PAGE: "Facebook",
  LINKEDIN: "LinkedIn",
  TWITTER: "X",
};

/** Cross-posting picker: lists the social accounts connected in the OpusClip dashboard and
 *  lets the operator choose which ones every posted clip is also published to. */
export default function CrosspostAccounts() {
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/social-accounts")
      .then((r) => r.json())
      .then((j) => (j.ok ? setAccounts(j.accounts) : setError(j.error ?? "failed to load")))
      .catch((e) => setError((e as Error).message));
  }, []);

  async function save(next: AccountRow[]) {
    setAccounts(next);
    setSaving(true);
    setError(null);
    try {
      const enabled = next.filter((a) => a.enabled).map(({ enabled: _e, ...a }) => a);
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ crosspostAccounts: JSON.stringify(enabled) }),
      });
      const json = await res.json();
      if (!json.ok) setError(json.error ?? "save failed");
      else setSavedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-8 max-w-md rounded-lg border border-neutral-800 p-4">
      <h3 className="mb-1 text-sm font-medium text-neutral-300">Cross-posting</h3>
      <p className="mb-3 text-xs text-neutral-500">
        Every posted clip is also published to the accounts checked below (same render, same
        credit-first caption) — so a single platform can never zero this bot&apos;s reach.
        Connect accounts in the OpusClip dashboard → Social accounts, then enable them here.
      </p>

      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
      {!accounts && !error && <p className="text-xs text-neutral-500">Loading connected accounts…</p>}
      {accounts && accounts.length === 0 && (
        <p className="text-xs text-amber-300">
          No social accounts connected in OpusClip yet. Connect TikTok / YouTube / Instagram at
          clip.opus.pro → Settings → Social accounts, then reload this page.
        </p>
      )}

      {accounts && accounts.length > 0 && (
        <ul className="space-y-2">
          {accounts.map((a) => (
            <li key={a.postAccountId} className="flex items-center gap-2 text-sm">
              <input
                id={`xpost-${a.postAccountId}`}
                type="checkbox"
                checked={a.enabled}
                disabled={saving}
                onChange={(e) =>
                  save(accounts.map((x) =>
                    x.postAccountId === a.postAccountId ? { ...x, enabled: e.target.checked } : x,
                  ))
                }
              />
              <label htmlFor={`xpost-${a.postAccountId}`} className="cursor-pointer">
                <b>{PLATFORM_LABEL[a.platform] ?? a.platform}</b>
                <span className="text-neutral-400"> — {a.name || a.postAccountId}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-neutral-600">
        {saving ? "Saving…" : savedAt ? "Saved." : ""}
      </p>
    </div>
  );
}
