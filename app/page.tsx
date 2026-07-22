import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, candidates, clips } from "@/lib/db";

export const dynamic = "force-dynamic";

const GITHUB_URL = "https://github.com/derek-coleman-opus/videoclipthis";

/** The public face of the deployment: project pitch + a showcase of the clips this
 *  instance found and posted. Reads the database directly (no API) and degrades to an
 *  empty showcase when the database isn't configured — the page must never 500 for
 *  an anonymous visitor. */
export default async function PublicHomePage() {
  const showcase = await loadShowcase();

  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      {/* Hero */}
      <header className="mb-14 text-center">
        <p className="mb-3 text-xs uppercase tracking-widest text-neutral-500">open source</p>
        <h1 className="mb-4 text-4xl font-bold">videoclipthis</h1>
        <p className="mx-auto mb-6 max-w-2xl text-lg text-neutral-300">
          An autonomous AI agent that watches the channels and people you care about, finds the
          best moments in their long videos, clips them, and posts them — with credit to the
          speaker, every time.
        </p>
        <div className="flex justify-center gap-3 text-sm">
          <a
            href={GITHUB_URL} target="_blank" rel="noreferrer"
            className="rounded-md bg-white px-4 py-2 font-medium text-black hover:bg-neutral-200"
          >
            Get the code on GitHub
          </a>
          <a
            href="https://x.com/videoclipthis" target="_blank" rel="noreferrer"
            className="rounded-md border border-neutral-600 px-4 py-2 text-neutral-200 hover:bg-neutral-800"
          >
            See it live: @videoclipthis
          </a>
        </div>
      </header>

      {/* How it works */}
      <section className="mb-14">
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-neutral-500">How it works</h2>
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Scout", "Cron watches your channels and tracked people for fresh long-form video."],
            ["Score", "Claude rates every video's clip-worthiness for your audience, 0–100."],
            ["Clip", "OpusClip finds and renders the viral moment inside the keepers."],
            ["Post", "Credit-first posts go to X — auto, or queued for your one-click review."],
          ].map(([title, body], i) => (
            <li key={title} className="rounded-lg border border-neutral-800 p-4">
              <div className="mb-1 text-xs text-neutral-600">{i + 1}</div>
              <div className="mb-1 font-medium">{title}</div>
              <div className="text-sm text-neutral-400">{body}</div>
            </li>
          ))}
        </ol>
      </section>

      {/* Any niche */}
      <section className="mb-14 rounded-lg border border-neutral-800 p-6">
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-neutral-500">Point it at any niche</h2>
        <p className="mb-3 max-w-3xl text-sm text-neutral-300">
          This deployment clips AI and developer content, but nothing about that is hard-coded.
          Self-host it, open the admin, and set three things — no code changes:
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-400">
          <li><b className="text-neutral-300">Niche</b> — the audience the AI scores clips for (fitness, travel, finance, …)</li>
          <li><b className="text-neutral-300">Watched channels</b> — the YouTube channels it monitors</li>
          <li><b className="text-neutral-300">Figures</b> — the people it tracks, credits, and tags</li>
        </ul>
        <p className="mt-3 text-sm text-neutral-500">
          Your keys, your database, your account — the repo ships with zero data and zero secrets.
        </p>
      </section>

      {/* Showcase */}
      <section className="mb-14">
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-neutral-500">
          Clips this agent found &amp; cut
        </h2>
        {showcase.length === 0 ? (
          <p className="rounded-lg border border-neutral-800 p-6 text-sm text-neutral-500">
            No posted clips to show yet — the agent is warming up. Meanwhile,{" "}
            <a href={`https://x.com/videoclipthis`} target="_blank" rel="noreferrer" className="underline hover:text-neutral-300">
              follow @videoclipthis
            </a>{" "}
            to catch them as they land.
          </p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {showcase.map((c) => (
              <li key={c.id} className="flex flex-col rounded-lg border border-neutral-800 p-4">
                {/* The proof: the actual rendered vertical clip, playable in place. */}
                {c.clipUrl && (
                  <video
                    src={c.clipUrl}
                    controls
                    playsInline
                    preload="metadata"
                    className="mb-3 aspect-[9/16] w-full rounded-md border border-neutral-800 bg-black object-contain"
                  />
                )}
                <Link href={`/clips/${c.id}`} className="mb-2 line-clamp-3 text-sm text-neutral-200 hover:underline">
                  {c.hookCaption || c.postText}
                </Link>
                <p className="mb-3 line-clamp-2 text-xs text-neutral-500">
                  {c.speaker ? `${c.speaker} — ` : ""}{c.title}
                </p>
                <div className="mt-auto flex gap-3 text-xs">
                  {c.xPostId && (
                    <a href={`https://x.com/i/status/${c.xPostId}`} target="_blank" rel="noreferrer" className="text-neutral-300 underline hover:text-white">
                      watch on X ↗
                    </a>
                  )}
                  {c.sourceUrl && (
                    <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="text-neutral-500 underline hover:text-neutral-300">
                      full video ↗
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-6 text-center text-sm">
          <Link href="/clips" className="text-neutral-300 underline hover:text-white">
            Browse the full clip library →
          </Link>
        </p>
      </section>

      <footer className="border-t border-neutral-800 pt-6 text-center text-xs text-neutral-600">
        <p>
          Built in public by{" "}
          <a href="https://x.com/derekisbuilding" target="_blank" rel="noreferrer" className="underline hover:text-neutral-400">
            @derekisbuilding
          </a>
          {" · "}
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="underline hover:text-neutral-400">source</a>
          {" · "}
          <Link href="/dashboard" className="underline hover:text-neutral-400">admin</Link>
        </p>
      </footer>
    </div>
  );
}

interface ShowcaseClip {
  id: number;
  hookCaption: string;
  postText: string;
  clipUrl: string;
  xPostId: string | null;
  title: string;
  speaker: string;
  sourceUrl: string;
}

async function loadShowcase(): Promise<ShowcaseClip[]> {
  try {
    const rows = await db()
      .select({ clip: clips, cand: candidates })
      .from(clips)
      .leftJoin(candidates, eq(clips.candidateId, candidates.id))
      .where(eq(clips.status, "posted"))
      .orderBy(desc(clips.postedAt))
      .limit(24);
    return rows.map(({ clip, cand }) => ({
      id: clip.id,
      hookCaption: clip.hookCaption ?? "",
      postText: clip.postText,
      clipUrl: clip.clipUrl ?? "",
      xPostId: clip.xPostId,
      title: cand?.title ?? "",
      speaker: cand?.speaker || cand?.figureName || "",
      sourceUrl: cand?.url ?? "",
    }));
  } catch {
    return []; // no DATABASE_URL / cold deployment — public page still renders
  }
}
