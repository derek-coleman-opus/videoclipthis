/** Compact "5m ago" / "2h ago" / "3d ago" — shared by the XBot queue card and activity page. */
export function timeAgo(input?: string | Date | null): string {
  if (!input) return "";
  const t = typeof input === "string" ? new Date(input).getTime() : input.getTime();
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
