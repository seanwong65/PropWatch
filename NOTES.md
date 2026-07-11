# PropWatch — Project Notes

Live reference only. History and superseded designs live in
[`NOTES-ARCHIVE.md`](./NOTES-ARCHIVE.md) (pitfall lessons kept there — read it
before re-touching an old area).

## Stack

| Layer | Technology |
|---|---|
| Backend | Cloudflare Worker (`worker/index.js`) |
| Frontend | Cloudflare Pages, single-file SPA (`frontend/index.html`) |
| Database | Cloudflare D1 (SQLite), database name `propwatch-db` |
| Deploy worker | `TMPDIR=/tmp npx wrangler deploy worker/index.js` |
| Deploy frontend | `TMPDIR=/tmp npx wrangler pages deploy frontend --project-name=propwatch --branch=main --commit-dirty=true` |
| Run tests | `npm --prefix worker test` (Vitest) |

> `TMPDIR=/tmp` is required — the default tmp dir runs out of space.

## Deploy checklist

Always run the tests before deploying the worker:

```bash
npm --prefix worker test && TMPDIR=/tmp npx wrangler deploy worker/index.js
```

Tests live in `worker/tests/unit.test.js` and cover pure utilities
(`hkDateStr`, `N()`, `getEstateCode`, `getEstateName`, `parseListing`, `sha256`).

## Git workflow

- **Always use feature branches** — never commit directly to `main`. Naming: `feat/…`, `fix/…`, `chore/…`.
- Each step = one commit with a rollback note in the message.
- **Stop and confirm before merging to `main` or restarting anything.**
  (Historically this was fully auto-merge; see the archive.)

## Listing sources

Three portals, described once in a `SOURCES` registry (worker) and a matching
one (frontend) — add a source in both and it auto-applies to sync, the enable
toggle, filters, badges and the schema column:

| id | 名 | notes |
|---|---|---|
| `centanet` | 中原 | listings **+ transactions + valuations** (only source with txns) |
| `ricacorp` | 利嘉閣 | listings only; no reliable publish date → DOM falls back to `first_seen` |
| `hkp` | 香港置業 | listings only; publish date from `post_date` |

- Listings that are the same unit (座+樓層+單位+實呎) across sources with prices
  within 5% are merged into one row; >5% stay separate (likely different flats).
- Days-on-market uses the **earlier** of the portal's publish date and our
  `first_seen`, so a "refreshed" fake-fresh date can't hide a stale listing.

## Sync & email (cron)

Cron is blocked from self-fetch (error 1042) and no Queues on this plan, so the
daily sync is split across staggered slots, each its own invocation (HKT=UTC+8):

| Cron (UTC) | HKT | Job |
|---|---|---|
| `0 16 * * *` | 00:00 | sync estates 0–11 (`SYNC_SLOTS` slot 0) |
| `10 16 * * *` | 00:10 | sync estates 12–23 |
| `20 16 * * *` | 00:20 | sync estates 24–35 |
| `0 1 * * *` | 09:00 | 今日動態 email (own invocation, fresh subrequest budget) |

Capacity = slots × `SYNC_SLOT_SIZE` (12). Add a slot cron to grow. Manual
`立即同步` (all estates) runs synchronously in parallel.

## Auth

Multi-account (register page open; original data all mapped to `seanwong`).
SHA-256 passwords, 30-day Bearer sessions in `localStorage` (`propwatch_token`).
All routes need auth except `/api/login`, `/api/logout`, `/api/register`
(`/api/send-today-email` and `/api/debug-ricacorp-pages` used to be public —
moved behind auth in the security hardening pass). **5 failed logins → account
disabled** (`is_active=0`); all failures return a generic `用戶名或密碼錯誤` (no count).
Re-enable: `UPDATE accounts SET is_active=1, failed_attempts=0 WHERE username='seanwong';`

## Security (conventions — follow for ALL new features)

See `CLAUDE.md` for the enforced conventions. Quick facts:

- **CORS**: allow-list only (`propwatch.pages.dev`, `*.propwatch.pages.dev`,
  `localhost:3456`) — reflected per-request by `applyCors()` at the single
  `fetch` exit; `json()` no longer sets `Access-Control-Allow-Origin` itself.
- **Rate limits**: in-memory fixed-window per isolate. Global (NOT per-account)
  settings keys with code defaults: `sec_auth_rpm` (login/register per-IP,
  default 10/min), `sec_api_rpm` (per-token/IP, default 240/min). Change via D1:
  `INSERT INTO settings (key,value) VALUES ('sec_api_rpm','500') ON CONFLICT(key) DO UPDATE SET value=excluded.value;`
- **Frontend escaping helpers** (bottom of index.html): `escHtml` (HTML text),
  `safeUrl` (hrefs — blocks `javascript:`), `safeImgSrc` (img src — http(s)/data:image
  only), `escJsAttr` (string args inside inline `onclick='fn("…")'` — escHtml
  alone does NOT escape single quotes).
- **Pages `_headers`**: CSP locks `connect-src` to the worker only and
  `img-src` to self+data: — injected script can't exfiltrate to third parties;
  `frame-ancestors 'none'` stops clickjacking.

## DB tables

| Table | Purpose |
|---|---|
| `estates` | Tracked estates (per-source `*_enabled` flags, auto-added by `ensureSourceColumns`) |
| `listings` | Daily snapshots from all 3 sources (`source`, `publish_date`, net area/`$/呎`) |
| `listing_price_history` | Price per `ref_no` per day (all sources) |
| `price_snapshots` | Daily aggregate stats per estate (centanet-based) |
| `transactions` | Sale transactions (Centanet); car parks & non-market deals filtered out |
| `viewings` | User's property viewings |
| `hangseng_valuations` / `_history` | Hang Seng bank valuations |
| `system_parameters` | Generic key/value catalogue (e.g. `notes_option`) with CRUD |
| `settings` | Legacy key/value (migration flags); notes options moved to `system_parameters` |
| `accounts` / `sessions` | Login accounts (`is_active`) / session tokens |

## Key helpers (worker)

- `SOURCES` / `syncEstateListings(db, estate)` — the source registry + per-estate sync
- `syncOneEstate` / `syncEstatesBatch(db, offset, size)` — one estate / one cron slice
- `sendDailyEmail(db, key)` — the digest email (separate from sync)
- `computeAskingSold(db)` / `computeViewingComps(db)` — negotiation-spread & comp analysis
- `fetchAndSaveTransactions` / `parseListing` / `parseHkpProperty` / `scrapeRicacorpListings`
- `hkDateStr`, `N()`, `normalizeUnit`, `ensureAuthTables`, `ensureSourceColumns`, `authenticate`
