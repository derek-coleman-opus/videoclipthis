import { db, events } from "@/lib/db";

/** Append a row to the activity feed. */
export async function logEvent(
  type: string, message: string, refTable?: string, refId?: number,
): Promise<void> {
  await db().insert(events).values({
    type, message, refTable: refTable ?? null, refId: refId ?? null,
  });
}
