import { eq } from "drizzle-orm";
import { db, settings, type Settings } from "@/lib/db";

/** Read the single settings row, creating it on first access. */
export async function getSettings(): Promise<Settings> {
  const database = db();
  const rows = await database.select().from(settings).where(eq(settings.id, 1)).limit(1);
  if (rows.length) return rows[0];
  const [created] = await database.insert(settings).values({ id: 1 }).returning();
  return created;
}

export async function updateSettings(
  patch: Partial<{
    paused: boolean; threshold: number; autonomy: string; dailyClipCap: number;
    niche: string; watchChannels: string; opusBrandTemplateId: string | null; searchTopics: string;
    crosspostAccounts: string;
  }>,
): Promise<Settings> {
  const database = db();
  await getSettings(); // ensure the row exists
  const [updated] = await database
    .update(settings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(settings.id, 1))
    .returning();
  return updated;
}

/** Parse the admin "Watched channels" field: one channel per line as
 *  "Name | youtubeHandle | xHandle" (both handles optional — YouTube names cost 100 quota
 *  units to resolve vs 1 for handles; the X handle enables tagging the brand in posts).
 *  Empty result means "use the code WATCHLIST defaults". */
export function parseWatchChannels(s: Settings): { name: string; handle?: string; xHandle?: string }[] {
  return (s.watchChannels ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, handle, xHandle] = line.split("|").map((p) => p.trim().replace(/^@/, ""));
      return { name, ...(handle ? { handle } : {}), ...(xHandle ? { xHandle } : {}) };
    })
    .filter((c) => c.name);
}

/** Parse the admin "Search topics" field (one keyword/phrase per line). Empty → code SEARCH_TOPICS. */
export function parseSearchTopics(s: Settings): string[] {
  return (s.searchTopics ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Persist pipeline state (Summon cursor, bot user id, search throttle + rotation offset). */
export async function updateSummonState(
  patch: Partial<{
    summonSinceId: string | null; xBotUserId: string | null;
    figureSearchAt: Date | null; searchOffset: number;
  }>,
): Promise<void> {
  const database = db();
  await getSettings();
  await database
    .update(settings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(settings.id, 1));
}
