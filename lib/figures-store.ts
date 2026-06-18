import { eq } from "drizzle-orm";
import { db, figures as figuresTable, type FigureRow } from "@/lib/db";
import { FIGURES, type Figure } from "@/lib/pipeline/figures";

function toFigure(r: FigureRow): Figure {
  return {
    name: r.name,
    xHandle: r.xHandle,
    org: r.org ?? undefined,
    role: r.role ?? undefined,
    priority: r.priority ?? undefined,
    youtubeChannelId: r.youtubeChannelId ?? undefined,
  };
}

/** Seed the built-in defaults, adding any that aren't already present (so expanding the code
 *  FIGURES list propagates to existing databases). Existing rows are left untouched. */
async function ensureSeeded(): Promise<void> {
  await db().insert(figuresTable).values(
    FIGURES.map((f) => ({
      name: f.name,
      xHandle: f.xHandle,
      org: f.org ?? "",
      role: f.role ?? "",
      priority: f.priority ?? 2,
      youtubeChannelId: f.youtubeChannelId ?? null,
    })),
  ).onConflictDoNothing();
}

/** Figures in the pipeline shape (seeds defaults on first use). */
export async function getFigures(): Promise<Figure[]> {
  await ensureSeeded();
  return (await db().select().from(figuresTable)).map(toFigure);
}

/** Full DB rows (with ids) for the admin table. */
export async function getFigureRows(): Promise<FigureRow[]> {
  await ensureSeeded();
  return db().select().from(figuresTable);
}

export async function addFigure(input: {
  name: string; xHandle: string; org?: string; role?: string; priority?: number; youtubeChannelId?: string;
}): Promise<FigureRow | null> {
  const xHandle = input.xHandle.replace(/^@/, "").trim();
  const [row] = await db().insert(figuresTable).values({
    name: input.name.trim(),
    xHandle,
    org: input.org?.trim() ?? "",
    role: input.role?.trim() ?? "",
    priority: input.priority ?? 2,
    youtubeChannelId: input.youtubeChannelId?.trim() || null,
  }).onConflictDoNothing().returning();
  return row ?? null;
}

export async function deleteFigure(id: number): Promise<void> {
  await db().delete(figuresTable).where(eq(figuresTable.id, id));
}
