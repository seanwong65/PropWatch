# PropWatch — Archive (history & superseded designs)

Narrative history moved out of `NOTES.md`. **Nothing is deleted** — the pitfall
lessons below stay so we don't re-step on them. Where a design was later
changed, the current behaviour is noted; see `NOTES.md` for the live reference.

---

## Superseded designs (still useful context)

### Login lockout → account disable (superseded 2026-07-03)
Originally: max 5 failed logins → **30-minute lockout** (`locked_until`).
**Now**: 5 failed logins → the account is **disabled** (`accounts.is_active = 0`,
manual re-enable). Also every credential failure returns an identical generic
`用戶名或密碼錯誤` — the old message leaked the attempt count and (because it
only appeared for a real username) allowed account enumeration. `locked_until`
still exists on the table but is no longer used.
Re-enable: `UPDATE accounts SET is_active=1, failed_attempts=0 WHERE username='seanwong';`

### Multi-account isolation — NOT active
`NOTES.md` once described `estates.account_id` filtering and per-account
settings (`notes_options_<account_id>`). **This is not implemented in the
current code** — estate queries are not account-scoped, and notes options live
in `system_parameters` (a single shared catalogue, not per-account). Auth is
single-user (`seanwong`). Kept here in case multi-account is revisited.

### Notes options: settings blob → system_parameters (2026-07-03)
Originally a single `settings.notes_options` newline blob (fragile: not in
schema, wipeable by an empty-value save). **Now** a `system_parameters` table
(`category='notes_option'`, one row per option, full CRUD via
`/api/system-params`). A one-time migration copies the old blob across, guarded
by a `settings.sysparam_migrated` flag. The legacy `/api/settings` endpoint is
left in place but unused by the frontend.

### Git workflow: auto-merge → confirm before merge
Earlier the workflow was fully automatic (commit → push → PR → merge with no
prompts). **Current preference**: always use feature branches, but **stop and
confirm before merging to `main` or restarting anything**. See `NOTES.md`.

---

## Pitfall lessons & past fixes (do not re-break)

### D1 migration pattern (recreate a table, e.g. drop a UNIQUE constraint)
```sql
PRAGMA foreign_keys=OFF;
CREATE TABLE foo_new (...);
INSERT INTO foo_new SELECT * FROM foo;
DROP TABLE foo;
ALTER TABLE foo_new RENAME TO foo;
PRAGMA foreign_keys=ON;
```
Run via `TMPDIR=/tmp npx wrangler d1 execute propwatch-db --remote --file=/tmp/migration.sql`

### 0個盤 bug
`today_count` used `date('now','+8 hours')` but the latest snapshot could be
yesterday. Fixed to a `MAX(snapshot_date)` subquery:
```sql
(SELECT COUNT(*) FROM listings l WHERE l.estate_id = e.id
 AND l.snapshot_date = (SELECT MAX(snapshot_date) FROM listings WHERE estate_id = e.id))
```

### 歷史動態 載入失敗
Listings subquery was missing `price` in its SELECT → `D1_ERROR: no such column: l.price`.

### 淘大花園 sync (persist:false bug)
`saveSearchResults` had `persist:false` which skipped saving; fixed to `true`.
`parseListing` also had `undefined` values not wrapped in `N()` → `D1_TYPE_ERROR`.

### Letter block matching (淘大花園 G座/B座)
`findBlockCode` splits `blockChinesename` on `--` (e.g. `"I期--B座"`) and matches
the last segment against the block letter.

### 對應放盤 letter blocks (德福花園 K座)
`findMatchingListings` extracted digits only (`match(/\d+/)`), returning empty
for letter blocks like "K". Fixed to fall back to the full stripped string:
`lBlockRaw.match(/\d+/)?.[0] || lBlockRaw`.

### Single-building estates (景怡峰, 別樹一居)
Their `block` equals the estate name (no 座 suffix), and Centanet returns
`buildingName = <estate name>`. Strip the estate name / 座 suffix before matching.

### 管理費 logic
If `mgmt_fee > 100`, treat it as the total monthly amount; otherwise multiply by `size_net`.

### 建築 vs 實呎
All three sources and every display use **實呎 (net)** for area and `$/呎`
(`nSize`/`nUnitPrice`, ricacorp `area-value`/`unit-price`, hkp
`net_area`/`price_over_net_area`). `size_gross` is stored separately, never shown as net.

### Cloudflare gotchas
- A Worker **cannot fetch its own route** (error **1042**) — no self-fetch chaining.
- Queues are not enabled on this account (`invalid queue settings`).
- A full sync of every estate × every source nearly exhausts the per-invocation
  **subrequest limit**, so the daily job is split across staggered cron slots
  and the digest email runs in its own invocation.

### UI history (2026-06-28)
- Viewings column order: 睇樓日期 → 單位 → 房數 → 實用面積 → 售價 → 恒生估值 →
  上次購買 → 成交記錄 → 管理費 → 對應放盤 → 備注 → 圖片
- 備注 field is a 2-row resizable `<textarea>`.
- 追蹤天數 lives in the estate info bar next to 樓齡/座數/發展商.
