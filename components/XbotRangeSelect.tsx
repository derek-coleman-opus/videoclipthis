"use client";

import { useRouter } from "next/navigation";

export const RANGE_OPTIONS = [
  { value: "today", label: "Today (UTC)" },
  { value: "yesterday", label: "Yesterday" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
] as const;

/** Time-range dropdown for the activity page — navigates via ?range= so the server component
 *  recomputes the metrics for the chosen window. */
export default function XbotRangeSelect({ range, kind }: { range: string; kind?: string | null }) {
  const router = useRouter();
  return (
    <select
      value={range}
      onChange={(e) => {
        const params = new URLSearchParams();
        params.set("range", e.target.value);
        if (kind) params.set("kind", kind);
        router.push(`/xbot/activity?${params.toString()}`);
      }}
      className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-200"
    >
      {RANGE_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
