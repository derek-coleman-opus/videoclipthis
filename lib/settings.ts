import { eq } from "drizzle-orm";
import { db, settings, type Settings } from "@/lib/db";
import { DEFAULT_PROFILE_KEY, findProfile } from "@/lib/pipeline/audience";

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
    activeProfile: string; profileOverrides: string; curationBrief: string;
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

/** Inverse of parseWatchChannels — render a profile's channel list into the admin text format. */
export function formatWatchChannels(
  list: { name: string; handle?: string; xHandle?: string }[],
): string {
  return list.map((c) => [c.name, c.handle ?? "", c.xHandle ?? ""]
    .join(" | ").replace(/(\s*\|\s*)+$/, "")).join("\n");
}

/** The subset of settings that belongs to an audience profile rather than to the account. */
export interface ProfileFields {
  niche: string;
  searchTopics: string;
  watchChannels: string;
  threshold: number;
  curationBrief: string;
}

function readOverrides(s: Settings): Record<string, Partial<ProfileFields>> {
  try {
    const parsed = JSON.parse(s.profileOverrides || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // corrupt JSON must never wedge the switch — fall back to preset defaults
  }
}

/** Switch the active audience profile.
 *
 *  Snapshots the CURRENT profile's editable fields into `profileOverrides` before loading the next
 *  one, so a round trip (dev → viral → dev) returns your hand-tuned topics and channels rather
 *  than the code defaults. A profile you have never customized loads from its preset.
 *
 *  Deliberately not a plain `updateSettings({activeProfile})`: writing only the key would leave the
 *  previous lane's topics and channels in place and produce exactly the half-switch this whole
 *  profile mechanism exists to prevent. */
export async function switchProfile(key: string): Promise<Settings> {
  const current = await getSettings();
  const target = findProfile(key);
  const overrides = readOverrides(current);

  overrides[current.activeProfile ?? DEFAULT_PROFILE_KEY] = {
    niche: current.niche ?? "",
    searchTopics: current.searchTopics ?? "",
    watchChannels: current.watchChannels ?? "",
    threshold: current.threshold,
    curationBrief: current.curationBrief ?? "",
  };

  const saved = overrides[target.key] ?? {};
  return updateSettings({
    activeProfile: target.key,
    profileOverrides: JSON.stringify(overrides),
    // `??` not `||`: a deliberately blanked field must stay blank (blank = "use the preset"),
    // where `||` would silently re-seed it from the preset on every switch.
    niche: saved.niche ?? target.niche,
    searchTopics: saved.searchTopics ?? target.searchTopics.join("\n"),
    watchChannels: saved.watchChannels ?? formatWatchChannels(target.watchChannels),
    threshold: saved.threshold ?? target.threshold,
    curationBrief: saved.curationBrief ?? "",
  });
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
