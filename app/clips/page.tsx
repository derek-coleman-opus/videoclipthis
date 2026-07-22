import type { Metadata } from "next";
import Link from "next/link";
import { getPostedClips, getSpeakers, siteUrl, speakerSlug } from "@/lib/publicClips";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AI talk clips — the best moments, credited | videoclipthis",
  description:
    "The best 30-90 second moments from fresh AI and developer talks, keynotes, and podcasts — found, clipped, and credited to their speakers by an autonomous agent.",
  alternates: { canonical: `${siteUrl()}/clips` },
};

/** The public clip library index — every posted clip, newest first. */
export default async function ClipsIndexPage() {
  let clips: Awaited<ReturnType<typeof getPostedClips>> = [];
  let speakers: Awaited<ReturnType<typeof getSpeakers>> = [];
  try {
    clips = await getPostedClips(60);
    speakers = await getSpeakers();
  } catch {
    /* database not configured — render an empty library rather than 500 for a visitor */
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-widest text-neutral-500">
          <Link href="/" className="hover:text-neutral-300">videoclipthis</Link> · clip library
        </p>
        <h1 className="mt-2 text-3xl font-bold">The best moments in AI talks</h1>
        <p className="mt-2 max-w-2xl text-neutral-400">
          30–90 second highlights from fresh talks, keynotes, and podcasts — found and clipped by
          an autonomous agent, always credited and linked to the full video.
        </p>
      </header>

      {speakers.length > 0 && (
        <nav className="mb-8 flex flex-wrap gap-2 text-xs">
          {speakers.slice(0, 20).map((s) => (
            <Link
              key={s.slug}
              href={`/speakers/${s.slug}`}
              className="rounded-full border border-neutral-700 px-3 py-1 text-neutral-300 hover:bg-neutral-800"
            >
              {s.name} ({s.clipCount})
            </Link>
          ))}
        </nav>
      )}

      {clips.length === 0 ? (
        <p className="text-neutral-500">No clips published yet — check back soon.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {clips.map((c) => (
            <li key={c.id} className="flex flex-col rounded-lg border border-neutral-800 p-4">
              <Link href={`/clips/${c.id}`} className="group">
                {c.clipUrl && (
                  <video
                    src={c.clipUrl}
                    muted
                    playsInline
                    preload="metadata"
                    className="mb-3 aspect-[9/16] w-full rounded-md border border-neutral-800 bg-black object-contain"
                  />
                )}
                <p className="mb-1 line-clamp-3 text-sm text-neutral-200 group-hover:underline">
                  {c.hookCaption || c.title}
                </p>
              </Link>
              <p className="line-clamp-2 text-xs text-neutral-500">
                {c.speaker ? (
                  <Link href={`/speakers/${speakerSlug(c.speaker)}`} className="hover:text-neutral-300">
                    {c.speaker}
                  </Link>
                ) : null}
                {c.speaker && c.title ? " — " : ""}{c.title}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
