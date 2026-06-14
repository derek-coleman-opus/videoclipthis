import { requireEnv } from "@/lib/pipeline/env";

/** The four OAuth 1.0a user-context tokens for the PERSONAL account (not @videoclipthis). */
const XBOT_WRITE_REQUIRED = [
  "XBOT_API_KEY",
  "XBOT_API_SECRET",
  "XBOT_ACCESS_TOKEN",
  "XBOT_ACCESS_SECRET",
] as const;

/** Liking, replying, posting as the personal account needs these. */
export function requireXbotEnv(): void {
  requireEnv(XBOT_WRITE_REQUIRED, "XBot writes to X (personal account)");
}

/** Searching tweets / reading timelines needs the personal app's bearer token. */
export function requireXbotReadEnv(): void {
  requireEnv(["XBOT_BEARER_TOKEN"], "XBot reads from X (personal app)");
}

/** Drafting replies/posts with Claude needs only the DB and Anthropic — no X credentials.
 *  This is what makes the queue usable before the X developer app exists. */
export function requireXbotDraftEnv(): void {
  requireEnv(["DATABASE_URL", "ANTHROPIC_API_KEY"], "XBot drafting");
}

/** True when the personal-account write tokens are configured (Phase 2+). */
export function hasXbotWriteEnv(): boolean {
  return XBOT_WRITE_REQUIRED.every((k) => process.env[k]?.trim());
}
