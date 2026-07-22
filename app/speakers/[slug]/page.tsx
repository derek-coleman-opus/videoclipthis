import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getClipsBySpeaker, siteUrl } from "@/lib/publicClips";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const data = await getClipsBySpeaker(slug).catch(() => null);
  if (!data) return { title: "Speaker not found | videoclipthis" };
  const title = `${data.speaker.name} — best talk moments | videoclipthis`;
  const description = `${data.speaker.clipCount} clipped highlight(s) from ${data.speaker.name}'s talks and interviews, each credited and linked to the full video.`;
  return { title, description, alternates: { canonical: `${siteUrl()}/speakers/${slug}` } };
}

/** All of one speaker's clipped moments — the page their fans (and they) can share. */
export default async function SpeakerPage({ params }: Props) {
  const { slug } = await params;
  const data = await getClipsBySpeaker(slug).catch(() => null);
  if (!data) notFound();
  const { speaker, clips } = data;

  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <p className="mb-6 text-xs uppercase tracking-widest text-neutral-500">
        <Link href="/" className="hover:text-neutral-300">videoclipthis</Link>
        {" · "}
        <Link href="/clips" className="hover:text-neutral-300">clip library</Link>
      </p>
      <h1 className="mb-1 text-3xl font-bold">{speaker.name}</h1>
      <p className="mb-8 text-sm text-neutral-400">
        {speaker.clipCount} clipped moment{speaker.clipCount === 1 ? "" : "s"}
        {speaker.handle && (
          <>
            {" · "}
            <a href={`https://x.com/${speaker.handle}`} target="_blank" rel="noreferrer" className="underline hover:text-white">
              @{speaker.handle} on X ↗
            </a>
          </>
        )}
      </p>

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
            <p className="line-clamp-2 text-xs text-neutral-500">{c.title}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
