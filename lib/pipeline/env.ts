/** Fail-fast environment validation. No mock fallbacks exist anymore — a run that
 *  can't reach its external services should abort loudly rather than silently no-op. */

/** Env vars the Scout pipeline needs to discover, score, clip, and post. */
const SCOUT_REQUIRED = [
  "DATABASE_URL",
  "YOUTUBE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPUSCLIP_API_KEY",
] as const;

/** The four OAuth 1.0a user-context tokens needed to upload media + post to X. */
const X_REQUIRED = [
  "X_API_KEY",
  "X_API_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_SECRET",
] as const;

function missing(keys: readonly string[]): string[] {
  return keys.filter((k) => !process.env[k]?.trim());
}

/** Throw if any of the given env vars are unset/blank. */
export function requireEnv(keys: readonly string[], context: string): void {
  const gaps = missing(keys);
  if (gaps.length) {
    throw new Error(
      `Missing required env for ${context}: ${gaps.join(", ")}. ` +
        `Set these before running — there is no mock fallback.`,
    );
  }
}

/** Discovery → scoring → clipping needs these. Call at the top of a scout run. */
export function requireScoutEnv(): void {
  requireEnv(SCOUT_REQUIRED, "the Scout pipeline");
}

/** Posting/replying to X needs these. Call before any publish. */
export function requireXEnv(): void {
  requireEnv(X_REQUIRED, "posting to X");
}

/** True when the X posting tokens are configured — used by paths that should quietly
 *  wait (approved clips queue up) rather than abort when posting isn't possible yet. */
export function hasXEnv(): boolean {
  return missing(X_REQUIRED).length === 0;
}

/** Reading tweet metrics / mentions needs a bearer token. */
export function requireXReadEnv(): void {
  requireEnv(["X_BEARER_TOKEN"], "reading from X");
}
