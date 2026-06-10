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
  patch: Partial<{ paused: boolean; threshold: number; autonomy: string }>,
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

/** Persist pipeline state (Summon poll cursor, cached bot user id, figure-search throttle). */
export async function updateSummonState(
  patch: Partial<{ summonSinceId: string | null; xBotUserId: string | null; figureSearchAt: Date | null }>,
): Promise<void> {
  const database = db();
  await getSettings();
  await database
    .update(settings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(settings.id, 1));
}
