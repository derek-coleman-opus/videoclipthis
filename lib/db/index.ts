import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

let _db: NeonHttpDatabase<typeof schema> | null = null;

/** Lazily-created Neon/Drizzle client. Lazy so `next build` never evaluates it
 *  without DATABASE_URL. Call as `db()`. */
export function db(): NeonHttpDatabase<typeof schema> {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _db = drizzle(neon(url), { schema });
  }
  return _db;
}

export * from "./schema";

/** What went wrong when a query failed, and what the operator should actually do about it.
 *  Every admin page renders "Database not ready"; without this they all told the operator to set
 *  DATABASE_URL and run db:push, which is the wrong instruction for a healthy-but-over-quota or
 *  temporarily-unreachable database. */
export interface DbErrorInfo {
  /** unconfigured: no DATABASE_URL · quota: plan limit hit · schema: missing table/column ·
   *  unreachable: transport/timeout · unknown: everything else. */
  kind: "unconfigured" | "quota" | "schema" | "unreachable" | "unknown";
  title: string;
  /** The actionable next step. */
  hint: string;
  /** True when the condition is expected to clear on its own (or on a retry). */
  retryable: boolean;
  message: string;
}

export function describeDbError(e: unknown): DbErrorInfo {
  const message = (e as Error)?.message ?? String(e);
  const m = message.toLowerCase();

  if (m.includes("database_url is not set")) {
    return {
      kind: "unconfigured", retryable: false, message,
      title: "Database not configured",
      hint: "Set DATABASE_URL, run `npm run db:push` (or open /api/admin/migrate), then click “Run Scout now”.",
    };
  }
  // Neon returns HTTP 402 with "exceeded the compute time quota" / "data transfer quota" once the
  // plan's allowance is used up. The schema and the connection string are both fine — the compute
  // is simply refusing work until the quota resets or the plan is upgraded.
  if (
    m.includes("status 402") ||
    m.includes("quota") ||
    m.includes("upgrade your plan")
  ) {
    return {
      kind: "quota", retryable: true, message,
      title: "Database over its plan quota",
      hint:
        "Neon is rejecting queries because the project used up its compute-time allowance — the schema and DATABASE_URL are fine, so db:push will not help. " +
        "Upgrade the Neon plan or wait for the monthly reset, then reload. To stop it recurring, lower the cron frequency in vercel.json so Neon's compute can autosuspend between runs.",
    };
  }
  if (m.includes("does not exist") || m.includes("undefined_table") || m.includes("undefined_column")) {
    return {
      kind: "schema", retryable: false, message,
      title: "Database schema out of date",
      hint: "Open /api/admin/migrate to sync the schema, then reload.",
    };
  }
  if (
    m.includes("econnrefused") || m.includes("etimedout") || m.includes("enotfound") ||
    m.includes("fetch failed") || m.includes("connection terminated") || m.includes("socket hang up")
  ) {
    return {
      kind: "unreachable", retryable: true, message,
      title: "Database unreachable",
      hint: "The database did not answer. If it is a Neon branch waking from suspend, reload in a few seconds.",
    };
  }
  return {
    kind: "unknown", retryable: false, message,
    title: "Database not ready",
    hint: "Check /api/admin/diagnostics for per-service health.",
  };
}
