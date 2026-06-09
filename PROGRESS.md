# videoclipthis — build progress (loop-driven)

**Loop contract.** Each iteration: take the TOP unchecked task → implement it to production
quality in TypeScript → run `npm run typecheck && npm run build` (both MUST pass) → check it
off with a one-line note → continue. Keep `MOCK_MODE` working end-to-end at every step; for
anything needing a live API key, write the real client code and mark the call `TODO-LIVE:`
(don't block on keys). Stop when all tasks are checked. Design ref: `../General SEO/videoclipthis-build-plan.md`.

## Tasks
- [x] 1. **Key AI figures tracking** — people watchlist (`figures.ts`), figure→handle resolution (always creditable), authority boost, Figures admin page. _Shipped: FIGURES list + matchFigure(), runScout resolves handle & boosts score, candidates.figureName, /figures page. typecheck+build green._
- [x] 2. **Real YouTube source** — Data API v3 polling (uploads playlist → duration + recency filter), watches org channels + every figure's channel. _Transcript fetch + WebSub push marked TODO-LIVE. typecheck+build green._
- [x] 3. **Real Claude scorer** — Anthropic Messages API via fetch (no SDK dep), rubric as system prompt → parsed {score, rationale}, clamped 0–100. _TODO-LIVE: ANTHROPIC_API_KEY. typecheck+build green._
- [x] 4. **Real OpusClip selection + clipping** — `opusclip.ts` client (analyze→best segment, render→9:16+captions); selector picks top virality score, clipper renders + composes the credit-first post. _TODO-LIVE: confirm endpoints + OPUSCLIP_API_KEY. typecheck+build green._
- [x] 5. **Real X publisher + Summon** — xPublisher (twitter-api-v2: clip → media upload → tweet/reply); `summon.ts` (mention→clip→reply, dedup, summon_requests + clips kind:summon); `/api/cron/summon` route + cron entry. _TODO-LIVE: X tokens + mention polling. typecheck+build green._
- [x] 6. **Admin actions** — `/api/clips/action` (approve→publish, reject→discard), ClipActions buttons on Posts for pending clips, `/replies` summon page + nav. _typecheck+build green._
- [x] 7. **Feedback loop** — `feedback.ts` (refresh views + detect reshares → events), `reshareBoost()` feeds proven speakers a score boost in runScout, `/api/cron/feedback` hourly cron. _TODO-LIVE: X metrics fetch. typecheck+build green._
- [x] 8. **Hardening** — `withRetry` (exp backoff) on all external calls (YouTube/Anthropic/OpusClip), per-run cost cap + max-clips cap in runScout, structured JSON logging (`slog`). _typecheck+build green._

## Notes
- Stack: Next.js + Vercel Cron + Neon Postgres + Drizzle (all TypeScript).
- Schema changes need `npm run db:push` at runtime (build/typecheck don't need the DB).

## BUILD COMPLETE (mock-mode, build-verified)

All 8 tasks shipped; `tsc --noEmit` + `next build` pass. The full pipeline runs end-to-end in `MOCK_MODE`.

**Built:** key-figures tracking · real YouTube ingest · Claude scorer · OpusClip select+clip · X publish + Summon · admin (dashboard / found / posts+approve / replies / figures / settings) · feedback loop · hardening (retry · cost/volume caps · structured logging). Crons: scout (30m), summon (5m), feedback (1h).

**To go live (`TODO-LIVE` markers in code):** real channel IDs + YouTube transcript fetch; OpusClip endpoint shapes (confirm at api.opus.pro) + key; X tokens + "Automated" label + mention polling; X metrics fetch. Then set keys, `MOCK_MODE=0`, raise autonomy `review → auto`.

**Run:** `npm install && npm run db:push && npm run dev` (set `DATABASE_URL` + `ADMIN_PASSWORD`). Deploy: import to Vercel + add Neon + set env. See README.
