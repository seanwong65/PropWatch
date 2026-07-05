# PropWatch — Project Notes

## Stack

| Layer | Technology |
|---|---|
| Backend | Cloudflare Worker (`worker/index.js`) |
| Frontend | Cloudflare Pages, single-file SPA (`frontend/index.html`) |
| Database | Cloudflare D1 (SQLite), database name `propwatch-db` |
| Deploy worker | `TMPDIR=/tmp npx wrangler deploy worker/index.js` |
| Deploy frontend | `TMPDIR=/tmp npx wrangler pages deploy frontend --project-name=propwatch --branch=main --commit-dirty=true` |
| Run tests | `cd worker && npm test` |

> `TMPDIR=/tmp` is required — the default tmp dir runs out of space due to a tasks directory issue.

## Deploy Checklist

**Always run tests before deploying the worker:**

```bash
cd worker && npm test && cd .. && TMPDIR=/tmp npx wrangler deploy worker/index.js
```

Tests live in `worker/tests/unit.test.js` (Vitest). They cover pure utility functions: `hkDateStr`, `N()`, `getEstateCode`, `getEstateName`, `parseListing`, `sha256`.

---

## Git Workflow

- **Always use feature branches** — never commit directly to `main`
- Branch naming: `feat/<short-description>`
- After committing: auto push + `gh pr create` + `gh pr merge` without asking for confirmation
- Example: `git checkout -b feat/login-protection`

---

## Key Conversations & Decisions

### Auto commit / push
User wants fully automatic git workflow — commit, push, PR create, PR merge — with no confirmation prompts at any step.

### Login Protection (added 2026-06-28)
- `accounts` table: `id, username, password_hash, expiry_date, failed_attempts, locked_until`
- `sessions` table: `token, account_id, created_at, expires_at` (30-day sessions)
- Passwords hashed with SHA-256 via Web Crypto API
- Max 5 failed attempts → 30-min lockout
- All routes protected except `POST /api/login` and `POST /api/logout`
- Token stored in `localStorage` as `propwatch_token`, sent as `Authorization: Bearer <token>`
- 401 response → frontend shows login screen
- Default account: `seanwong` / `123456` / expiry `2099-12-31` (auto-seeded on first request)
- CORS headers must include `Authorization`: `"Access-Control-Allow-Headers": "Content-Type, Authorization"`

### Multi-account Isolation (added 2026-06-28)
- `estates` table gained `account_id` column (migration: recreate table with `UNIQUE(bigestcode, account_id)` instead of `UNIQUE(bigestcode)`)
- All estate queries filtered by `session.account_id`
- Settings scoped per account: key `notes_options` → `notes_options_<account_id>`
- Dashboard (今日動態, 歷史動態, 追蹤中放盤) all filtered by account
- Old seanwong settings migrated: `UPDATE settings SET key = 'notes_options_1' WHERE key = 'notes_options'`

### D1 Migration Pattern
To recreate a table (e.g. drop a UNIQUE constraint):
```sql
PRAGMA foreign_keys=OFF;
CREATE TABLE foo_new (...);
INSERT INTO foo_new SELECT * FROM foo;
DROP TABLE foo;
ALTER TABLE foo_new RENAME TO foo;
PRAGMA foreign_keys=ON;
```
Run via `TMPDIR=/tmp npx wrangler d1 execute propwatch-db --remote --file=/tmp/migration.sql`

### 0個盤 Bug Fix
`today_count` was using `date('now','+8 hours')` but the latest snapshot was yesterday. Fixed to use `MAX(snapshot_date)` subquery:
```sql
(SELECT COUNT(*) FROM listings l WHERE l.estate_id = e.id
 AND l.snapshot_date = (SELECT MAX(snapshot_date) FROM listings WHERE estate_id = e.id))
```

### 歷史動態 載入失敗
SQL subquery for listings was missing `price` in SELECT, causing `D1_ERROR: no such column: l.price`.

### 淘大花園 Sync (persist:false bug)
`saveSearchResults` had `persist:false` which skipped saving. Fixed to `persist:true`. Also `parseListing` had `undefined` values not wrapped in `N()`, causing `D1_TYPE_ERROR`.

### Letter Block Matching (淘大花園 G座, B座)
`findBlockCode` now splits `blockChinesename` on `--` (e.g. `"I期--B座"`) and matches the last segment against the block letter.

### 對應放盤 Letter Blocks (德福花園 K座)
`findMatchingListings` extracted digits only (`match(/\d+/)`), returning empty for letter blocks like "K". Fixed to fall back to full stripped string: `lBlockRaw.match(/\d+/)?.[0] || lBlockRaw`.

### 管理費 Logic
If `mgmt_fee > 100`, treat as total monthly amount (not per-sqft). Otherwise multiply by `size_net`.

### 上次購買 Single-Building Estates
Estates like 景怡峰 have `block = "景怡峰"` (no 座 suffix). Centanet returns `buildingName = "景怡峰"`. Fixed by stripping 座 suffix before matching.

### 追蹤天數
Moved from a separate stat card into the estate info bar alongside 樓齡/座數/發展商.

### Viewings Table Column Order (2026-06-28)
睇樓日期 → 單位 → 房數 → 實用面積 → 售價 → 恒生估值 → 上次購買 → 成交記錄 → 管理費 → 對應放盤 → 備注 → 圖片

### 備注 Field
Changed from single-line `<input>` to 2-row `<textarea>` (resizable).

### Dashboard Tabs (2026-06-28)
Dashboard has two tabs: 今日動態 and 追蹤中放盤.
- 追蹤中放盤: all viewings across all estates where unit has no transaction after the viewing date
- API: `GET /api/viewings/unsold` (account-scoped)

---

## DB Tables

| Table | Purpose |
|---|---|
| `estates` | Tracked estates, one row per (bigestcode, account_id) |
| `listings` | Daily listing snapshots from Centanet |
| `listing_price_history` | Price changes per listing ref_no |
| `price_snapshots` | Daily aggregate stats per estate |
| `transactions` | Sale transactions from Centanet |
| `viewings` | User's property viewings/inspections |
| `hangseng_valuations` | Hang Seng Bank valuations |
| `hangseng_valuation_history` | Historical HS valuations |
| `settings` | Key-value settings, keyed as `notes_options_<account_id>` |
| `accounts` | Login accounts |
| `sessions` | Auth session tokens |

## Helpers

- `hkDateStr(offsetDays)` — HK timezone date string
- `N(v)` — converts `undefined` → `null` for D1 bindings
- `parseListing(item)` — maps Centanet listing JSON to DB fields
- `findBlockCode(blocks, blockNum)` — looks up HSBC block code
- `findMatchingListings(viewing, listings)` — matches viewings to current listings
- `ensureAuthTables(db)` — creates auth tables + seeds seanwong account on every request
- `authenticate(db, request)` — validates Bearer token, returns session or null
