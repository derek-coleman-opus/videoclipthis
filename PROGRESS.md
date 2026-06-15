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

## Post-launch milestones

### XBot — personal-account growth bot
- [x] **Phase 1 — drafting + review** — 6 `xbot_*` tables; Claude drafts replies/follow-ups/posts; review queue with inline edit + approve/reject; anti-spam guards (duplicate detection, daily caps, quiet hours, per-target cooldown); separate `XBOT_*` credentials, drafting-only without them. Starts paused, review-everything.
- [x] **Growth playbook encoded** — reply prompt requires funny/contrarian/value-adding (generic-praise + follower-bait auto-rejected); mission storyline injected into prompts; post variants ship a media idea (text-only underperforms); `plug` self-reply links the product under a traction post; `community_id` posts originals into a niche community; defaults set to method (3 posts/day, engage 9am–5pm EST, targets <5k). New `/xbot/playbook` page with persisted 0-followers checklist.
- [x] **Reply-to-everyone loop** — `inbound.ts` pulls new mentions (comments on our posts + replies to our replies), queues an `engage` draft per engager; manual button + `/api/cron/xbot-inbound` (30m); separate engage-back cap so it never competes with outbound replies; commenters flagged `engaged_back`.
- [x] **X automation-rules pacing** — daily caps spread into an hourly cap (daily ÷ active hours) + per-kind minimum gaps (replies 5m, engage 3m, posts 30m), all ledger-based; no bursting a day's budget.
- [x] **Outbound reply-guy loop** — `outbound.ts` round-robins the roster (least-recently-checked), reads each target's fresh ORIGINAL posts (`userTimeline`, no @-tag needed), drafts a useful reply to the best one via `draftReply`; skips cooldown/pending targets before any API call; hydrates `xUserId`/bio. Manual button + `/api/cron/xbot-outbound` (2h).
- [x] **Autonomous discovery** — `discovery.ts` searches niche keywords (rotating), Claude `scoreAccount()` strictly gates niche-fit/real-builder, auto-adds passers as `candidate` targets (≥65, follower sweet-spot prefilter); per-run caps + roster-max ceiling; manual button + `/api/cron/xbot-discover` (6h). Targets page shows score rationale + keep/archive triage.

### Open-source restructure
- [x] **Public/private split** — public `/` landing + showcase of posted clips (degrades with no DB); all admin moved into `app/(admin)` route group behind `ADMIN_PASSWORD` (dashboard now `/dashboard`); middleware allows only `/` + `/api/cron/*`. Verified: `/` 200, admin/api 401 unauthenticated.
- [x] **Niche as a setting** — `settings.niche` feeds the Claude scoring rubric; `settings.watch_channels` overrides the code `WATCHLIST` at scout time; both editable in admin Settings. Point it at fitness/travel/finance with no code changes.
- [x] **OSS hygiene** — MIT `LICENSE`; README rewritten for self-hosters; repo ships zero data + zero secrets (scan clean). Console-SQL single-statement rule recorded in `CLAUDE.md`; `scripts/xbot-schema-bootstrap.sql` for Neon-console migration.

_All shipped on branch `claude/vigilant-goodall-ci4rs2` (PR #15); `tsc --noEmit` + `next build` green; auth + pacing behavior verified at runtime._
