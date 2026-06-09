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

One Next.js app: the pipeline lives in `lib/pipeline/*`, the activity store is Drizzle/Postgres (`lib/db`), the Scout runs on Vercel Cron (`vercel.json`), and the admin UI is `app/*`. **Mock mode runs the whole thing end-to-end with no external APIs**, so you can deploy and see it working before any keys exist.

## Local quickstart

```bash
npm install
cp .env.example .env            # set DATABASE_URL (Neon) + ADMIN_PASSWORD; leave MOCK_MODE=1
npm run db:push                 # create tables
npm run dev                     # http://localhost:3000  (basic-auth: any user + ADMIN_PASSWORD)
```
Then click **Run Scout now** on the dashboard (or `POST /api/dev/seed` for richer demo data).

> Verify before claiming done: `npm run typecheck && npm run build`.

## Deploy to Vercel

1. Push this folder to a GitHub repo; **Import** it in Vercel.
2. Add a Postgres store (Vercel Postgres/Neon) → it sets `DATABASE_URL`.
3. Set env vars: `ADMIN_PASSWORD`, `CRON_SECRET` (any random string), `MOCK_MODE=1`.
4. Run `npm run db:push` against the Neon URL (locally or via a one-off) to create tables.
5. Deploy. The Scout cron in `vercel.json` runs automatically every 30 min; the admin is the site root (basic-auth protected).

## Going live (M-next)

Mock mode is on until real clients are wired. Each is an isolated stub with the exact interface already in place:

| File | Wire up | Build-plan ref |
|---|---|---|
| `lib/pipeline/sources.ts` | YouTube WebSub + Data API ingest + transcripts | §3.1 |
| `lib/pipeline/scoring.ts` | Claude rubric scorer | §3.3 |
| `lib/pipeline/selection.ts` | OpusClip ClipAnything + Claude curator | §3.4 |
| `lib/pipeline/production.ts` | OpusClip clip/reframe/caption/export | §4 |
| `lib/pipeline/publishing.ts` | X v2 post/reply (Automated label) + Summon | §4/§7 |

Then set the keys (below), `MOCK_MODE=0`, and raise **autonomy** in Settings from `review` → `auto` once the ranking is trusted.

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
