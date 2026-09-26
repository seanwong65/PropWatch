# 搵樓日記 — Project Notes

Live reference only. History and superseded designs live in
[`NOTES-ARCHIVE.md`](./NOTES-ARCHIVE.md) (pitfall lessons kept there — read it
before re-touching an old area).

## Stack

| Layer | Technology |
|---|---|
| Backend | Cloudflare Worker (`worker/index.js`) |
| Frontend | Cloudflare Pages. App = single-file SPA `frontend/app.html` (served at `/app`, noindex); public landing `frontend/index.html` + static pages (`/mortgage-calculator`, `/guides/*`, `/about`, `/privacy`) sharing `site.css` |
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

- **成交：完全一樣** —— 連 transaction id 都相同。所以兩個之中只可以有一個
  做 master，**master = 香港置業**，美聯個 `txn`／`rentTxn` 已經喺 registry
  剪走（2026-08-21）。實測（1,622 宗 hkp 成交）：**2026 年成交美聯獨有 0 宗**，
  美聯獨有嗰 9 宗全部係 2023–2025 嘅舊成交，佔 0.55%。
  點解 master 揀香港置業：已有 1,622 宗標咗 hkp，而 combo UNIQUE 索引係
  先入為主，就算轉美聯做 master 嗰批都**永遠改唔到名**，個成交表會變成
  一半「香港置業」一半「美聯」——同一份數據兩個名，仲亂。
  代價：香港置業爆咗嗰陣成交冇後備。要頂返上去就係喺 SOURCES 加返
  `txn`／`rentTxn` 兩行（`scrapeMidlandTransactions` 冇刪，仲喺度）。
  收益：每日慳 14 個成交單元。
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

## 訂閱狀態同對數

`accounts.tier`（free/paid）係唯一真相，全部 gate 行 `isPaidSession()`。降級
**唔會刪任何嘢**：超出免費版上限嘅屋苑訂閱標記做 `account_estates.paused_at`
（保留最愛嗰幾個），升級返就一次過解除。暫停咗嘅唔 sync、唔計入上限。
⚠️ estates 跨帳戶共用，sync 係 per-estate，所以淨係當冇任何其他帳戶仲生效
訂緊，先真係慳到 sync 額度。

改 tier 有 **5 條路徑**，全部要 call `applyTierEstateLimit()`：
`applySubscription`（subscription.created/updated）、`subscription.deleted`、
`checkout.session.completed` 冇-subscription 分支、`authenticate()` 人手開通
到期、admin `/api/admin/tiers`。

**續期唔使我哋做嘢**——Stripe subscription 自動循環扣數，我哋淨係聽 webhook
更新 DB。冇任何 code 會主動去 Stripe 收錢。

**對數（reconcileSubscriptions）**：所有降級都靠 webhook，webhook 一漏個帳戶
就永遠停喺 paid。所以每日喺 **email cron 度搭順風車**行一次對數（唔開新 cron
trigger——Free plan 得 5 個 expression，已經用咗 2 個）。慳 subrequest 嘅關鍵：
用 `GET /v1/subscriptions?status=all&limit=100` **一次過**攞晒再喺 JS match，
唔係逐個帳戶 call（無論幾多訂閱者都係 1–2 個 subrequest）。
順序一定要「先對數、後寄信」，否則啱啱降咗級嘅人仲會收到當日封收費版 email。
`past_due`/`unpaid`/`incomplete`（`PAYMENT_TROUBLE_STATUSES`）嗰批會 **skip 埋
當日 email**——張卡碌唔到嘅人最唔需要收到「今日動態」。
手動版：`POST /api/admin/billing/reconcile`（全帳戶）／`/api/admin/billing/sync`
（單一帳戶）。

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

### 每日自動恒生估值（2026-09-25 起）

等同每日幫一個屋苑撳一次「批量查估值」，掛喺 `*/2` drip cron 入面：
**當日同步單元全部做完（`syncBatch` 回 idle、過咗 06:00）先開始**，唔搶同步、唔影響 09:00 email。

- **範圍**：有付費用戶**或 admin**（同 `isPaidSession` 一致）訂閱、冇暫停、冇 disable 嘅屋苑，按 id 輪。
  `settings.hs_scan_cursor` 記上次揀咗邊個，做完最後一個返第一個（15 個屋苑 ≈ 15 日一轉）。
- **單位**：該屋苑 `transactions` 入面所有座／樓／室（同成交表「查估值」掣同一批）。
- **特登唔讀 cache**：手動查估值查過一次就永遠用 cache，唔重新查就永遠唔更新。每次寫最新值＋每日一筆歷史（`saveHangSengValuation`）。
- **分段**：每次 invocation 最多 `HS_SCAN_BATCH`（40）個、每個之間停 `HS_SCAN_GAP_MS`（300ms）、`HS_SCAN_TIME_BUDGET_MS`（45s）封頂。進度喺 `settings.hs_scan_state`（當日屋苑、offset、ok／noResult／failed）。實測 ~1.1 秒一個。
- **完成**：發一條 telegram（屋苑名、幾多個有估值）。
- **手動**：`GET /api/admin/hs-scan` 睇進度同輪候名單；`POST` 行一段（test worker 冇 cron，靠呢個測）。

**座號規則 `hsBlockKey`**（worker 同 `app.html` 各有一份，**一定要一致**；`tests/unit.test.js` 會直接由 app.html 抽出嚟比較）。恒生 API 實測：
`A座`→`A`（傳 `A座` 會 404）、`05座`→`5`（`05` 404）、`23A座`→`23A`。
舊規則「抽數字」會令 `23A座` 變 `23`，恒生照回 23 座嘅估值＝**靜靜顯示錯單位嘅價**（海逸豪園 23A座 10D：真 $1,026萬，舊規則出 $1,837萬）。
淘大花園／德福花園（字母座）、黃埔花園（`05座`）以前幾乎全部查唔到，改完頭 40 個全中。
成交表 API 而家連利嘉閣／美聯系補返嘅成交都用同一條 key 配估值（以前淨係中原行有）。

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
- **Frontend escaping helpers** (bottom of app.html): `escHtml` (HTML text),
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
