import { db, xbotTargets } from "@/lib/db";
import { logEvent } from "@/lib/pipeline/events";
import { slog } from "@/lib/pipeline/util";
import {
  ACCOUNT_SCORE_THRESHOLD, DISCOVERY_ADD_PER_RUN, DISCOVERY_SCORE_PER_RUN,
  MIN_FOLLOWERS, SEARCH_MAX_RESULTS, SEARCH_QUERIES_PER_RUN, TARGET_ROSTER_MAX,
} from "./config";
import { describeXbotError, xbotRw } from "./client";
import { scoreAccount } from "./drafting";
import { getXbotSettings, parseKeywords } from "./settings";

export interface DiscoveryResult {
  searched: number;    // queries run
  evaluated: number;   // accounts scored by Claude
  added: number;       // new targets added to the roster
  rosterFull?: boolean;
}

interface Candidate {
  id: string;
  handle: string;
  name: string;
  bio: string;
  followers?: number;
  following?: number;
  sampleTweets: string[];
}

/** Autonomous roster discovery: search the niche keywords for fresh original posts, judge each
 *  unseen author with Claude (strict niche-fit/real-builder gate), and auto-add the good ones as
 *  "candidate" targets — which the outbound loop then engages, all under review. Stops when the
 *  roster is full; per-run caps bound Claude cost and X search quota. Reuses the OAuth1.0a client
 *  (recent search works in user context), so it needs only the XBOT_* write tokens. */
export async function runDiscovery(): Promise<DiscoveryResult> {
  const settings = await getXbotSettings();
  const database = db();
  const client = await xbotRw();
  const result: DiscoveryResult = { searched: 0, evaluated: 0, added: 0 };

  // Existing roster: dedup against it and respect the cap on active members.
  const existing = await database
    .select({ handle: xbotTargets.handle, status: xbotTargets.status })
    .from(xbotTargets);
  const known = new Set(existing.map((t) => t.handle.toLowerCase()));
  const activeCount = existing.filter((t) => !["archived", "blocked"].includes(t.status)).length;
  if (activeCount >= TARGET_ROSTER_MAX) {
    await logEvent("xbot_discovery", `Roster full (${activeCount}/${TARGET_ROSTER_MAX}) — discovery idle`);
    return { ...result, rosterFull: true };
  }

  const keywords = parseKeywords(settings);
  if (!keywords.length) return result;
  // Rotate which queries run each invocation so all keywords get coverage over time.
  const offset = Math.floor(Date.now() / 3_600_000) % keywords.length;
  const rotated = [...keywords.slice(offset), ...keywords.slice(0, offset)];
  const queries = rotated.slice(0, SEARCH_QUERIES_PER_RUN);

  const meId = settings.xbotUserId;
  const candidates = new Map<string, Candidate>(); // by lowercased handle

  for (const kw of queries) {
    try {
      const res = await client.v2.search(`${kw} -is:retweet -is:reply lang:en`, {
        max_results: Math.max(10, SEARCH_MAX_RESULTS),
        expansions: ["author_id"],
        "tweet.fields": ["author_id", "text"],
        "user.fields": ["username", "name", "description", "public_metrics"],
      }).catch((e) => { throw describeXbotError(e); });
      result.searched++;

      const users = res.includes?.users ?? [];
      const usersById = new Map(users.map((u) => [u.id, u]));
      for (const tweet of res.tweets ?? []) {
        const u = tweet.author_id ? usersById.get(tweet.author_id) : undefined;
        if (!u || u.id === meId) continue;
        const handleKey = u.username.toLowerCase();
        if (known.has(handleKey)) continue;
        const c = candidates.get(handleKey) ?? {
          id: u.id, handle: u.username, name: u.name ?? "",
          bio: u.description ?? "",
          followers: u.public_metrics?.followers_count,
          following: u.public_metrics?.following_count,
          sampleTweets: [],
        };
        if (c.sampleTweets.length < 3 && tweet.text) c.sampleTweets.push(tweet.text);
        candidates.set(handleKey, c);
      }
    } catch (e) {
      slog("xbot_discovery_search_error", { query: kw, error: (e as Error).message });
    }
  }

  let remainingRoster = TARGET_ROSTER_MAX - activeCount;
  for (const c of candidates.values()) {
    if (result.added >= DISCOVERY_ADD_PER_RUN || result.evaluated >= DISCOVERY_SCORE_PER_RUN) break;
    if (remainingRoster <= 0) { result.rosterFull = true; break; }

    // Follower sweet spot prefilter (the method's <5k rule) — saves a Claude call on
    // obviously-too-big or empty accounts.
    const fc = c.followers;
    if (fc != null && (fc < MIN_FOLLOWERS || fc > settings.maxFollowers)) continue;

    result.evaluated++;
    let scored;
    try {
      scored = await scoreAccount({
        handle: c.handle, bio: c.bio, followers: c.followers, following: c.following,
        sampleTweets: c.sampleTweets, voiceNotes: settings.voiceNotes ?? "", mission: settings.mission ?? "",
      });
    } catch (e) {
      slog("xbot_discovery_score_error", { handle: c.handle, error: (e as Error).message });
      continue;
    }
    if (scored.score < ACCOUNT_SCORE_THRESHOLD) continue;

    try {
      const [added] = await database.insert(xbotTargets).values({
        xUserId: c.id,
        handle: c.handle,
        displayName: c.name,
        bio: c.bio,
        followers: c.followers ?? 0,
        following: c.following ?? 0,
        score: scored.score,
        rationale: scored.rationale,
        source: "search",
        status: "candidate",
      }).returning();
      known.add(c.handle.toLowerCase());
      remainingRoster--;
      result.added++;
      await logEvent(
        "xbot_discovery",
        `Added @${c.handle} [${scored.score}] — ${scored.rationale}`,
        "xbot_targets", added.id,
      );
    } catch (e) {
      // Unique-handle race or constraint — treat as already known, keep going.
      slog("xbot_discovery_insert_skip", { handle: c.handle, error: (e as Error).message });
    }
  }

  await logEvent(
    "xbot_discovery",
    `Discovery: ${result.searched} search(es), ${result.evaluated} scored, ${result.added} added`,
  );
  slog("xbot_discovery", { ...result });
  return result;
}
