// Data layer for the PUBLIC clip library (/clips, /clips/[id], /speakers/[slug]) — the one
// distribution channel no platform can lock or rate-limit. Only POSTED clips are ever public.

import { desc, eq } from "drizzle-orm";
import { db, candidates, clips } from "@/lib/db";

export interface PublicClip {
  id: number;
  hookCaption: string;
  postText: string;
  clipUrl: string;         // OpusClip export URL — may expire (~30 days); the X embed is durable
  xPostId: string | null;
  postedAt: Date | null;
  title: string;           // source video title
  speaker: string;
  speakerHandle: string;
  channel: string;
  sourceUrl: string;
}

/** Site origin for canonical URLs / sitemap. */
export function siteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return vercel ? `https://${vercel}` : "http://localhost:3000";
}

/** URL-safe slug for a speaker name ("Lance Martin" → "lance-martin"). */
export function speakerSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

function toPublic(row: { clip: typeof clips.$inferSelect; cand: typeof candidates.$inferSelect | null }): PublicClip {
  return {
    id: row.clip.id,
    hookCaption: row.clip.hookCaption ?? "",
    postText: row.clip.postText,
    clipUrl: row.clip.clipUrl ?? "",
    xPostId: row.clip.xPostId,
    postedAt: row.clip.postedAt,
    title: row.cand?.title ?? "",
    speaker: row.cand?.speaker || row.cand?.figureName || "",
    speakerHandle: row.cand?.speakerHandle ?? "",
    channel: row.cand?.channel ?? "",
    sourceUrl: row.cand?.url ?? "",
  };
}

export async function getPostedClips(limit = 60): Promise<PublicClip[]> {
  const rows = await db()
    .select({ clip: clips, cand: candidates })
    .from(clips)
    .leftJoin(candidates, eq(clips.candidateId, candidates.id))
    .where(eq(clips.status, "posted"))
    .orderBy(desc(clips.postedAt))
    .limit(limit);
  return rows.map(toPublic);
}

/** One posted clip by id; null for unknown ids AND for non-posted clips — the review queue
 *  must never leak onto the public site. */
export async function getPostedClip(id: number): Promise<PublicClip | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await db()
    .select({ clip: clips, cand: candidates })
    .from(clips)
    .leftJoin(candidates, eq(clips.candidateId, candidates.id))
    .where(eq(clips.id, id))
    .limit(1);
  const row = rows[0];
  if (!row || row.clip.status !== "posted") return null;
  return toPublic(row);
}

export interface SpeakerSummary {
  name: string;
  slug: string;
  handle: string;
  clipCount: number;
}

/** Distinct speakers across posted clips, with counts — powers /speakers/[slug] + the sitemap. */
export async function getSpeakers(): Promise<SpeakerSummary[]> {
  const all = await getPostedClips(500);
  const byName = new Map<string, SpeakerSummary>();
  for (const c of all) {
    if (!c.speaker) continue;
    const slug = speakerSlug(c.speaker);
    if (!slug) continue;
    const cur = byName.get(slug);
    if (cur) cur.clipCount++;
    else byName.set(slug, { name: c.speaker, slug, handle: c.speakerHandle, clipCount: 1 });
  }
  return [...byName.values()].sort((a, b) => b.clipCount - a.clipCount);
}

export async function getClipsBySpeaker(slug: string): Promise<{ speaker: SpeakerSummary; clips: PublicClip[] } | null> {
  const all = await getPostedClips(500);
  const matches = all.filter((c) => c.speaker && speakerSlug(c.speaker) === slug);
  if (!matches.length) return null;
  return {
    speaker: {
      name: matches[0].speaker,
      slug,
      handle: matches.find((c) => c.speakerHandle)?.speakerHandle ?? "",
      clipCount: matches.length,
    },
    clips: matches,
  };
}
