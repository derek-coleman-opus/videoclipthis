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
5. Deploy. `vercel.json` runs **scout** and **summon** every 30 min, **xbot-post** every 30 min, **xbot-outbound** hourly, **xbot-inbound** every 2 h (engage-backs), and **feedback** + **xbot-discover** every 6 h, with `maxDuration=300` on the pipeline routes (requires **Vercel Pro** — Hobby caps crons at daily and functions at 60s). The site root is the public showcase; the admin lives at `/dashboard` (basic-auth protected). Keep autonomy on `review` until the clip quality is proven, then switch to `auto` in Settings.

### Neon compute: read this before changing any schedule

`HTTP 402 … exceeded the compute time quota` on every admin page means the Neon project burned
its monthly compute allowance. It is the easiest way to take this whole app down, and cadence is
only half the cause. The mechanism, in order of how much it costs you:

1. **Compute SIZE multiplies everything.** Neon bills `CU-hrs` — compute-*unit* hours, not
   wall-clock hours. A project left autoscaling to 2 CU burns 8× what a 0.25 CU compute does for
   the identical workload. In the Neon console: **Branch → Compute → Edit**, set min **and** max
   to **0.25 CU**. This workload never needs more, and it is the single biggest lever. (A real
   incident: 110 CU-hrs against a 100 CU-hr plan in 63 hours — ~1.75 CU running continuously.)
2. **Autosuspend delay is billed idle time.** The default is 5 minutes, and it restarts on every
   query. Set it to **60 seconds** (Branch → Compute → Edit). At 48 wake-ups a day that is ~3 h/day
   of pure idle billing recovered.
3. **Wake-up COUNT matters more than query count.** Each wake costs `run duration + autosuspend
   delay`, whatever the run actually did. Crons on `*/15` and `*/30` used to stagger into separate
   wake windows at `:00 :15 :30 :45` — 96/day. Every schedule now lands on `:00` or `:30`, so the
   crons that fire together **share one wake window**: 48/day. Keep it that way — a new cron on
   `*/20` or `*/10` silently doubles the wake count even if it queries almost nothing.
4. **Long routes hold the compute open.** These crons carry `maxDuration=300` and spend most of it
   waiting on Anthropic, OpusClip, and YouTube — the DB stays awake for the whole call, not just
   the queries. This is why a "cheap" 30-min cron is not cheap.

Budget check: `plan CU-hrs ÷ 0.25` = the awake-hours you can afford per month. A 100 CU-hr plan
buys ~400 h, or ~13 h/day. With 0.25 CU + 60 s autosuspend + 48 wakes/day the app lands near
**12 CU-hrs/month**, leaving plenty for the admin UI.

Two more things that keep it awake: every admin page is `force-dynamic`, so a dashboard tab left
open bills compute on each load — close it when you're done. And tightening `summon` back to
`*/15` buys faster @-mention replies at roughly double the wake count.

The costs of the current cadence, so you can trade them back deliberately: summon replies take up
to 30 min to appear (was 15), a finished render waits up to 30 min for the next scout/summon cycle
to collect it, and view counts refresh every 6 h instead of hourly.

## Going live

The pipeline is wired to real services; you only need keys and the X account label.

| File | Live integration |
|---|---|
| `lib/pipeline/sources.ts` + `transcript.ts` | YouTube Data API ingest + caption transcripts |
| `lib/pipeline/scoring.ts` | Claude rubric scorer |
| `lib/pipeline/selection.ts` + `opusclip.ts` | OpusClip ClipAnything project (async create → poll clips) |
| `lib/pipeline/editorial.ts` | The editor: picks the best of a project's renders, vetoes unshareable ones, writes the verbatim pull quote |
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

**The editorial gate.** Between "render finished" and "clip posted" sits `lib/pipeline/editorial.ts`.
One Claude call compares the renders OpusClip produced for a project (you pay per minute of
*source* video, so they're all bought and paid for), picks the best, scores it 0-100 on
shareability, and writes the verbatim **pull quote** that becomes the post's first line. Clips
below `EDITORIAL_MIN_SCORE` (default 65) are **never auto-posted** — they land in `/posts` for
review with the editor's reason, so you keep the override on a render you already paid for.
Expect it to veto roughly half: `dailyClipCap` is a ceiling, not a quota to fill. If Anthropic is
unreachable the editor returns no opinion and the top-ranked clip posts as before — an outage must
never silently stop the account.

The post itself leads with the speaker's own words and puts the source link in an **in-thread
follow-up** rather than the body (a link in the body costs reach; the credit-first promise only
needs the full talk to be one tap away). Cross-posts to other platforms get the link appended
inline, since only X penalizes it.

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
