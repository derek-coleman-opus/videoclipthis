# videoclipthis

Autonomous dev/AI video-clipping agent **+ a Vercel admin panel** to watch what it found, posted, and replied to.

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
npm run dev                     # http://localhost:3000  (basic-auth: any user + ADMIN_PASSWORD)
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
5. Deploy. `vercel.json` runs **scout** every 30 min, **summon** every 5 min, and **feedback** hourly; the admin is the site root (basic-auth protected). Keep autonomy on `review` until the clip quality is proven, then switch to `auto` in Settings.

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

> **OpusClip note:** the client follows the published contract (`POST /api/clip-projects` →
> poll `GET /api/exportable-clips?q=findByProjectId`; clip fields `uriForExport`, `score`,
> `durationMs`, `title`). Two enum values remain to confirm with the API team (marked
> `TODO-CONFIRM` in `opusclip.ts`): `curationPref.model` ("ClipAnything") and
> `renderPref.layoutAspectRatio` ("9:16").

### Access checklist
| Need | For | Where |
|---|---|---|
| `ANTHROPIC_API_KEY` | scoring + curation | console.anthropic.com |
| `OPUSCLIP_API_KEY` | clip/reframe/caption | confirm agent-reachable tier w/ Product |
| `YOUTUBE_API_KEY` | ingest + transcripts | Google Cloud console |
| X dev account (v2 write + stream) + **"Automated" label** | posting + summon | developer.x.com — **apply early, long lead** |

## Fork it for your niche
Change `WATCHLIST` in `lib/pipeline/config.ts` to point the Scout at your sources (crypto, sports, finance, gamedev…) — the rest of the pipeline is niche-agnostic.

---
The original Python proof-of-concept (which proved the pipeline design) is archived in `poc-python/`.
