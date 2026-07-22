import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPostedClip, siteUrl, speakerSlug } from "@/lib/publicClips";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const clip = await getPostedClip(Number(id)).catch(() => null);
  if (!clip) return { title: "Clip not found | videoclipthis" };
  const title = `${clip.hookCaption || clip.title}${clip.speaker ? ` — ${clip.speaker}` : ""} | videoclipthis`;
  const description = `The best moment of "${clip.title}"${clip.speaker ? ` by ${clip.speaker}` : ""}, clipped and credited. Watch the highlight and the full talk.`;
  return {
    title,
    description,
    alternates: { canonical: `${siteUrl()}/clips/${clip.id}` },
    openGraph: { title, description, type: "video.other", url: `${siteUrl()}/clips/${clip.id}` },
    twitter: { card: "summary_large_image", title, description },
  };
}

/** One public clip page: playable highlight, speaker credit, link to the full talk, and the
 *  posted X thread. The <video> uses the render URL (may expire after ~30 days); the X link
 *  is the durable home of the clip. */
export default async function ClipPage({ params }: Props) {
  const { id } = await params;
  const clip = await getPostedClip(Number(id)).catch(() => null);
  if (!clip) notFound();

  // Structured data: VideoObject makes these pages eligible for video rich results.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: clip.hookCaption || clip.title,
    description: `Highlight from "${clip.title}"${clip.speaker ? ` by ${clip.speaker}` : ""}`,
    uploadDate: clip.postedAt ? new Date(clip.postedAt).toISOString() : undefined,
    contentUrl: clip.clipUrl || undefined,
    url: `${siteUrl()}/clips/${clip.id}`,
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <p className="mb-6 text-xs uppercase tracking-widest text-neutral-500">
        <Link href="/" className="hover:text-neutral-300">videoclipthis</Link>
        {" · "}
        <Link href="/clips" className="hover:text-neutral-300">clip library</Link>
      </p>

      <h1 className="mb-2 text-2xl font-bold">{clip.hookCaption || clip.title}</h1>
      <p className="mb-6 text-sm text-neutral-400">
        {clip.speaker && (
          <>
            <Link href={`/speakers/${speakerSlug(clip.speaker)}`} className="text-neutral-200 underline hover:text-white">
              {clip.speaker}
            </Link>
            {clip.speakerHandle && (
              <>
                {" "}(
                <a href={`https://x.com/${clip.speakerHandle}`} target="_blank" rel="noreferrer" className="underline hover:text-white">
                  @{clip.speakerHandle}
                </a>
                )
              </>
            )}
            {" · "}
          </>
        )}
        {clip.title}
        {clip.channel ? ` · ${clip.channel}` : ""}
        {clip.postedAt ? ` · ${new Date(clip.postedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}` : ""}
      </p>

      {clip.clipUrl ? (
        <video
          src={clip.clipUrl}
          controls
          playsInline
          preload="metadata"
          className="mx-auto mb-6 aspect-[9/16] w-full max-w-sm rounded-lg border border-neutral-800 bg-black object-contain"
        />
      ) : clip.xPostId ? (
        <p className="mb-6 text-sm text-neutral-400">
          The rendered file has been archived — watch the clip on{" "}
          <a href={`https://x.com/i/status/${clip.xPostId}`} target="_blank" rel="noreferrer" className="underline hover:text-white">X ↗</a>.
        </p>
      ) : null}

      <div className="mb-10 flex flex-wrap gap-3 text-sm">
        {clip.xPostId && (
          <a
            href={`https://x.com/i/status/${clip.xPostId}`}
            target="_blank" rel="noreferrer"
            className="rounded-md bg-white px-4 py-2 font-medium text-black hover:bg-neutral-200"
          >
            Watch on X ↗
          </a>
        )}
        {clip.sourceUrl && (
          <a
            href={clip.sourceUrl}
            target="_blank" rel="noreferrer"
            className="rounded-md border border-neutral-600 px-4 py-2 text-neutral-200 hover:bg-neutral-800"
          >
            Full talk ↗
          </a>
        )}
      </div>

      <footer className="border-t border-neutral-800 pt-6 text-xs text-neutral-600">
        Found, clipped &amp; posted by an autonomous agent — credit-first, always linking the full
        talk. <Link href="/" className="underline hover:text-neutral-400">How it works</Link>
      </footer>
    </div>
  );
}
