import { eq } from "drizzle-orm";
import { db, xbotSettings, type XbotSettings } from "@/lib/db";
import { DEFAULT_KEYWORDS } from "./config";

/** Read the single XBot settings row, creating it (paused, review-everything) on first access. */
export async function getXbotSettings(): Promise<XbotSettings> {
  const database = db();
  const rows = await database.select().from(xbotSettings).where(eq(xbotSettings.id, 1)).limit(1);
  if (rows.length) return rows[0];
  const [created] = await database
    .insert(xbotSettings)
    .values({ id: 1, keywords: JSON.stringify(DEFAULT_KEYWORDS) })
    .returning();
  return created;
}

export type XbotSettingsPatch = Partial<{
  paused: boolean;
  replyAutonomy: string;
  postAutonomy: string;
  likesAuto: boolean;
  dailyReplyCap: number;
  dailyLikeCap: number;
  dailyPostCap: number;
  dailyEngageCap: number;
  cooldownDays: number;
  quietStartUtc: number;
  quietEndUtc: number;
  maxFollowers: number;
  keywords: string;
  voiceNotes: string;
  mission: string;
  productUrl: string;
  communityId: string;
  setupChecklist: string;
  searchSinceId: string | null;
  mentionsSinceId: string | null;
  xbotUserId: string | null;
}>;

export async function updateXbotSettings(patch: XbotSettingsPatch): Promise<XbotSettings> {
  const database = db();
  await getXbotSettings(); // ensure the row exists
  const [updated] = await database
    .update(xbotSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(xbotSettings.id, 1))
    .returning();
  return updated;
}

/** Parse the keywords JSON column, tolerating hand-edited/legacy values. */
export function parseKeywords(s: XbotSettings): string[] {
  try {
    const arr = JSON.parse(s.keywords);
    if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
  } catch { /* fall through */ }
  return DEFAULT_KEYWORDS;
}

/** Parse the playbook setup-checklist column (JSON array of completed item ids). */
export function parseSetupChecklist(s: XbotSettings): string[] {
  try {
    const arr = JSON.parse(s.setupChecklist ?? "[]");
    if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
  } catch { /* fall through */ }
  return [];
}
