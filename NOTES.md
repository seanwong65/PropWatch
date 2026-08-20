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

Four portals, described once in a `SOURCES` registry (worker) and a matching
one (frontend) — add a source in both and it auto-applies to sync, the enable
toggle, filters, badges and the schema column:

| id | 名 | notes |
|---|---|---|
| `centanet` | 中原 | listings **+ transactions + valuations** (only source with valuations) |
| `ricacorp` | 利嘉閣 | listings + land-reg txns; no reliable publish date → DOM falls back to `first_seen` |
| `hkp` | 香港置業 | listings + land-reg txns + rentals; publish date from `post_date` |
| `midland` | 美聯 | listings + land-reg txns + rentals; **no** publish date field → falls back to `first_seen` |

⚠️ **美聯同香港置業係同一間公司、同一個後台**（HKP 係美聯集團旗下），API 連
欄位名都一樣（所以兩者共用 `parseHkpProperty` / `parseHkpTransaction`，只係
HKP 行 `search/v1`、美聯行 `search/v2`）。實測分別：

- **成交：完全一樣** —— 連 transaction id 都相同。首次 sync 14 個屋苑，美聯
  抓返 ~400 宗淨係入到 **3 宗**，其餘全部俾 `transactions` 個 combo UNIQUE
  索引擋走。即係美聯成交幾乎唔會帶新數據，佢嘅價值係「HKP 熄咗嗰陣頂得住」。
- **放盤：零重疊** —— `serial_no` 前綴唔同（`M…` vs `H…`），係兩盤各自嘅代理
  盤源。實測美聯常常多過 HKP（黃埔花園 77 vs 1、碧海藍天 39 vs 17）。
  呢度先係加美聯嘅真正收益。

- Listings that are the same unit (座+樓層+單位+實呎) across sources with prices
  within 5% are merged into one row; >5% stay separate (likely different flats).
- Days-on-market uses the **earlier** of the portal's publish date and our
  `first_seen`, so a "refreshed" fake-fresh date can't hide a stale listing.

## 按揭計算機

前端 pure function（`stampDuty` / `maxLoanFor` / `mipPremium` /
`monthlyPayment` / `mortgageBreakdown` / `affordability`），client-side 計，
唔經 worker——逐個字打都要即時出數，冇必要行 round trip。

三個 table 係「官方數字」，改政策淨係改佢哋（每個都寫住出處同生效日）：

| Table | 係咩 | 出處 |
|---|---|---|
| `AVD_BANDS` | 從價印花稅稅階（含邊際寬免 band） | [稅務局](https://www.ird.gov.hk/chi/faq/avd.htm)，2026-02-26 起 |
| `MIP_LTV`（`maxLoanFor`） | 最高按揭成數 + 貸款額上限 | [按證保險](https://www.hkmc.com.hk/chi/our_business/mortgage_insurance_programme.html) |
| `MIP_PREMIUM` | 按揭保險保費率（表1–表4） | [按證保險保費一覽表 2024-10](https://www.hkmc.com.hk/files/product_file/3/1398/Premium%20Rate%20Sheet_Chi_clean_16102024.pdf) |

現行制度重點（做嗰陣查證返嚟，全部影響計法）：
- **SSD／BSD／NRSD 已經喺 2024-02-28 撤銷** —— 住宅買賣淨係剩 AVD 一項，
  所以印花稅唔再分首置／非首置。
- **壓力測試（+2% 加息）喺 2025-02-28 取消**，DSR 上限 50%（2024-10-16 起劃一）。
- 金管局基本按揭成數 **70%**；要高過就要買按揭保險，按證再按樓價封頂。
- 按保 **90%** 嗰級要「名下冇任何香港住宅 + 全部申請人固定受薪」。
- **$1,715萬以上做唔到按保**（$1,715萬–$3,000萬 嗰級淨係適用於 2024-10-16
  前簽臨約嘅個案），所以新買入嘅貴價樓最多做 70%。

`MIP_PREMIUM` 只收錄最常見嗰個組合：**浮息 + 一次過付清 + 新買樓**。
官方仲有定息版、每年支付版，同埋畀「有未供完按揭」嘅申請人用嘅 60%-起表。

律師費同代理佣金**冇官方公價**，所以做成可改輸入而唔係寫死：實測 28Hse
用 $600萬→$32,500、$800萬→$37,500（跟樓價滑），但一般轉手樓報價低到
$8,000–$15,000，差太遠，扮準反而誤導。

驗證方法（改完數字要重做）：攞同一組 input 去對中原同 28Hse 兩個計算機。
實測 $800萬／30年／3.5%／9成／首置，**每一行都同 28Hse 一模一樣**
（月供 $32,331、印花稅 $240,000、按保 $180,000 @2.5%、佣金 $80,000）；
中原個 default（$600萬 / 7成 / 30年 / 3.25%）月供 $18,279、入息要求
$36,558、印花稅 $135,000 亦完全一致。

入口有兩個：偏好 popup 填「買盤預算」嗰格下面（註冊流程嗰個問題），
同快捷面板嘅 🧮。計完可以一鍵寫返個樓價落 `pref-price-max`。

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
| `listings` | Daily snapshots from all 4 sources (`source`, `publish_date`, net area/`$/呎`) |
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
