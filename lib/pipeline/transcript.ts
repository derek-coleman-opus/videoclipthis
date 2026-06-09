import { withRetry } from "./util";

// Fetch a YouTube video's caption text. There is no official Data API endpoint for arbitrary
// videos' captions, so we read the watch page's player response, find the caption track baseUrl,
// and pull the json3 transcript — the same approach the youtube-transcript libraries use.
// This is best-effort: returns "" when a video has no captions or the page shape changes, and
// callers fall back to the video description so the scorer always has *some* signal.

const WATCH = "https://www.youtube.com/watch?v=";

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string; // "asr" => auto-generated
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function extractCaptionTracks(html: string): CaptionTrack[] {
  const m = html.match(/"captionTracks":(\[.*?\])/);
  if (!m) return [];
  try {
    return JSON.parse(m[1].replace(/\\u0026/g, "&")) as CaptionTrack[];
  } catch {
    return [];
  }
}

/** Prefer a manual English track, then auto English, then whatever exists. */
function pickTrack(tracks: CaptionTrack[]): CaptionTrack | undefined {
  return (
    tracks.find((t) => t.languageCode?.startsWith("en") && t.kind !== "asr") ??
    tracks.find((t) => t.languageCode?.startsWith("en")) ??
    tracks[0]
  );
}

/** Best-effort transcript for a video; "" if unavailable (caller falls back to description). */
export async function fetchTranscript(videoId: string): Promise<string> {
  try {
    return await withRetry(
      async () => {
        const page = await fetch(`${WATCH}${videoId}`, {
          headers: { "accept-language": "en", "user-agent": "Mozilla/5.0 (compatible; videoclipthis/1.0)" },
        });
        if (!page.ok) throw new Error(`watch ${page.status}`);
        const tracks = extractCaptionTracks(await page.text());
        const track = pickTrack(tracks);
        if (!track?.baseUrl) return "";

        const url = `${track.baseUrl.replace(/\\u0026/g, "&")}&fmt=json3`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`timedtext ${res.status}`);
        const data: any = await res.json();
        const text: string = (data.events ?? [])
          .flatMap((e: any) => (e.segs ?? []).map((s: any) => s.utf8 ?? ""))
          .join("")
          .replace(/\s+/g, " ")
          .trim();
        return decodeEntities(text);
      },
      { label: `transcript ${videoId}` },
    );
  } catch {
    return ""; // no captions / shape changed — caller falls back to description
  }
}

/** Transcript if we can get one, else the description as a weaker stand-in. */
export async function transcriptOrDescription(videoId: string, description: string): Promise<string> {
  const t = await fetchTranscript(videoId);
  return t || description || "";
}
