import type { MetadataRoute } from "next";
import { getPostedClips, getSpeakers, siteUrl } from "@/lib/publicClips";

export const dynamic = "force-dynamic";

/** Public pages only: home, the clip library, every posted clip, every speaker page. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const entries: MetadataRoute.Sitemap = [
    { url: base, changeFrequency: "daily", priority: 1 },
    { url: `${base}/clips`, changeFrequency: "hourly", priority: 0.9 },
  ];
  try {
    const [clips, speakers] = await Promise.all([getPostedClips(500), getSpeakers()]);
    for (const c of clips) {
      entries.push({
        url: `${base}/clips/${c.id}`,
        lastModified: c.postedAt ?? undefined,
        changeFrequency: "monthly",
        priority: 0.7,
      });
    }
    for (const s of speakers) {
      entries.push({ url: `${base}/speakers/${s.slug}`, changeFrequency: "weekly", priority: 0.6 });
    }
  } catch {
    /* database unavailable → ship the static entries rather than 500 */
  }
  return entries;
}
