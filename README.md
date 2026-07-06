# videoclipthis

Open-source autonomous video-clipping agent **+ a Vercel admin panel** to watch what it found, posted, and replied to. This deployment clips dev/AI content, but the niche is a **setting, not code** — self-host it and point it at fitness, travel, finance, anything (see [Point it at your niche](#point-it-at-your-niche)).

**Public vs private:** the site root (`/`) is a public landing page that showcases the clips your instance found and cut. Everything else — the dashboard (`/dashboard`), review queues, settings, and the XBot growth panel — is behind `ADMIN_PASSWORD` basic auth. The repo ships with zero data and zero secrets: your database, keys, and posting accounts stay yours.

- **Daily Scout (own page):** hunts source platforms (YouTube, podcasts, events — *not just X*), surfaces the viral moments from fresh talks **first**, posts daily.
- **Summon (`@videoclipthis`):** tagged in a thread → clips the relevant moment → replies.
- **Credit-first:** every clip tags + credits the speaker and links the full talk — a gift, not a rip-off, so they reshare it.

Built on the [OpusClip](https://opus.pro) API (the part that's #1 in the world at finding the viral moment inside long video). Design docs: `../General SEO/videoclipthis-build-plan.md` + `opusclip-developer-buildinpublic-strategy.md`.

## Architecture (all on Vercel)

```
Vercel Cron ──GET /api/cron/scout──▶ runScout() ──writes──▶ Neon Postgres ──reads──▶ Next.js admin (this app)
                                        │
                              OpusClip · Claude · YouTube · X  (real clients: M-next)
```

One Next.js app: the pipeline lives in `lib/pipeline/*`, the activity store is Drizzle/Postgres (`lib/db`), the crons run on Vercel Cron (`vercel.json`), and the admin UI is `app/*`. **There is no mock mode** — every run hits the real services and aborts loudly if a required key is missing. The safety net is the `autonomy=review` gate: in review mode the pipeline discovers, scores, and clips, but never posts until you approve a clip in the admin.

## Local quickstart

```bash
npm install
cp .env.example .env            # set DATABASE_URL (Neon), ADMIN_PASSWORD, and the service keys below
npm run db:push                 # create tables
npm run dev                     # http://localhost:3000 → public landing; /dashboard → admin (any user + ADMIN_PASSWORD)
```
Then click **Run Scout now** on the dashboard, or run a cycle from the terminal:

```bash
npm run scout       # discover -> score -> clip -> queue (review) / post (auto)
npm run summon      # process new @mentions and reply with clips
npm run feedback    # refresh views + speaker-reshare signal on posted clips
npm run pipeline    # scout, then summon, then feedback (the full cycle)
```

> Verify before claiming done: `npm run typecheck && npm run build`.

## Deploy to Vercel (Pro — for frequent crons)

1. Push this folder to a GitHub repo; **Import** it in Vercel.
2. Add a Postgres store (Vercel Postgres/Neon) → it sets `DATABASE_URL`.
3. Set env vars: `ADMIN_PASSWORD`, `CRON_SECRET` (any random string), plus all the service keys below.
4. Run `npm run db:push` against the Neon URL (locally or via a one-off) to create tables.
5. Deploy. `vercel.json` runs **scout** every 30 min, **summon** every 5 min, **feedback** hourly, **xbot-inbound** every 30 min (engage-backs), and **xbot-outbound** every 2 h (replies to your target roster's fresh posts), with `maxDuration=300` on the pipeline routes (requires **Vercel Pro** — Hobby caps crons at daily and functions at 60s). The site root is the public showcase; the admin lives at `/dashboard` (basic-auth protected). Keep autonomy on `review` until the clip quality is proven, then switch to `auto` in Settings.

## Going live

The pipeline is wired to real services; you only need keys and the X account label.

| File | Live integration |
|---|---|
| `lib/pipeline/sources.ts` + `transcript.ts` | YouTube Data API ingest + caption transcripts |
| `lib/pipeline/scoring.ts` | Claude rubric scorer |
| `lib/pipeline/selection.ts` + `opusclip.ts` | OpusClip ClipAnything project (async create → poll clips) |
| `lib/pipeline/production.ts` | Credit-first post around the OpusClip-rendered clip |
| `lib/pipeline/publishing.ts` | X v2 post/reply with native video (needs the **Automated** label) |
| `lib/pipeline/summon.ts` + `feedback.ts` + `xread.ts` | X mention polling + metrics/reshare reads |

> **OpusClip note:** the client is verified against OpusClip's own reference CLI
> (`POST /api/clip-projects` → poll `GET /api/exportable-clips?q=findByProjectId`;
> `clipDurations: [[min,max]]`, `layoutAspectRatio: "portrait"`, clip fields `uriForExport`,
> `renderAsVideoFile.pending`, `judgeResult.hookScore`). Probe it live at
> `/api/debug/opusclip`; list your brand templates at `/api/debug/brand-templates` and set
> one in Settings so vertical framing + captions match your brand.

**Posting behavior in production:** with `autonomy=auto`, finished clips queue as
`approved` and drip out — at most **dailyClipCap** per day (admin Settings, default 6) with
at least `MIN_CLIP_POST_GAP_MIN` (20 min) between posts. Summon replies skip the cap (a human
asked). Failed publishes keep the rendered clip and show a **Retry post** button on `/posts`.
Cron routes fail closed: `CRON_SECRET` must be set or every cron returns 503.

### Access checklist
| Need | For | Where |
|---|---|---|
| `ANTHROPIC_API_KEY` | scoring + curation | console.anthropic.com |
| `OPUSCLIP_API_KEY` | clip/reframe/caption | confirm agent-reachable tier w/ Product |
| `YOUTUBE_API_KEY` | ingest + transcripts | Google Cloud console |
| X dev account (v2 write + stream) + **"Automated" label** | posting + summon | developer.x.com — **apply early, long lead** |

## Point it at your niche
No code changes needed — open the admin and set three things:

1. **Settings → Niche** — the audience description Claude scores clip-worthiness against (e.g. `strength training & fitness`, `budget travel`).
2. **Settings → Watched channels** — the YouTube channels the Scout monitors, one `Name | youtubeHandle` per line (overrides the built-in `WATCHLIST` in `lib/pipeline/config.ts`).
3. **Figures** — the people it tracks, credits, and tags (their channels are watched and their appearances on other channels are searched).

The scoring rubric, clipping, credit-first posting, and review queue are all niche-agnostic. The XBot panel (personal-account growth on X) is configured the same way: its mission, keywords, and target roster live in **XBot Settings**.

---
The original Python proof-of-concept (which proved the pipeline design) is archived in `poc-python/`.
