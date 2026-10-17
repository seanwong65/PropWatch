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

## 公開搜尋（`/search`，2026-10-10 起）

未登入都用得嘅「四大地產網一次過搜尋」，做網站入口吸會員（跟 SEEHSE 搵樓街做法）。
**搜嘅係地產網本身，唔係我哋 DB**——規矩見 `CLAUDE.md`「`GET /api/public/search`」。

- 前端：`frontend/search.html` + `frontend/public-search.js`；首頁 hero 下面有個
  GET form 去 `/search`（純 HTML，唔使 JS）。條件全部喺 URL，可以分享。
  每個網站一個 request（`?src=centanet|midland|hkp|ricacorp`）並行，邊個返先出邊個；
  分開 request 亦等於分開 CPU 預算（Workers Free 每次 10ms）。
- 單位：URL／表單 `pmin`／`pmax` 買盤係**萬**、租盤係**元**；`public-search.js`
  send 去 worker 先換做 HK$。
- 各網 API（全部只讀，同每日 sync 同一批）：

| 網站 | API | 排序 | 備註 |
|---|---|---|---|
| 中原 | `POST hk.centanet.com/findproperty/api/Post/Search` | `sort: PublishDate, order: Descending` | `bedroomCount` 要 array；3+ 房 = `[4..8]` |
| 美聯 | `GET data.midland.com.hk/search/v2/properties` | `sort=latest` | 租盤都係用 `price=`（`rent=` 冇效）；kw → `autocomplete/estates` 攞 `est_ids` |
| 香港置業 | `GET data.hkp.com.hk/search/v1/properties` | `sort=latest` | 同美聯同一個後台；token 30 分鐘 cache |
| 利嘉閣 | `GET www.ricacorp.com/zh-hk/property/api/post` + header `x-custom-header` | `orderBy=overallDateModified desc` | 租盤 `agreementType=5`（`marketPrice`＝月租，`priceFrom/To` 照用）；每頁固定 10 個；**本機 IP 被 WAF 擋**，要經 Cloudflare 試 |

- ⚠️ **利嘉閣 JSON API 有 per-IP 限流**（2026-10-10 實測：隔 10 秒次次得，隔 4 秒 5 次有 4 次
  429「The request is blocked」；Cloudflare 出口 IP 會變，所以有時連續幾次都得）。HTML 列表頁
  （每日 sync 用嗰種）**冇**呢個限制，但每頁 ~1MB、2–6 秒（試過 62 秒）。所以：
  - 公開搜尋：被擋一次，isolate 停 10 秒唔再撩（`_ricaBlockedUntil`），回 `502 {retry:10}`；
    前端每頁自動再試一次（顯示「搵緊…」），再唔得就**靜靜收埋嗰個網站**——唔出「暫時搵唔到」，
    用戶會以為係我哋有 bug（2026-10-10 用戶要求）；四網全部搵唔到先喺結果區講「請稍後再試」。
  - **每日 sync 唔好轉用 JSON API**：一個屋苑十幾頁連續打一定被擋；每頁一樣係 10 個盤、
    0.4–1.1MB，請求數唔會少，D1 寫入量亦一樣（同點樣抓冇關）。

- 相：全部直接 `<img>` 熱連結（實測冇 referer 檢查），唔經 worker proxy；縮圖：
  中原 hkais `?w=400`、hkvrdata `?x-oss-process=image/resize,w_400`；美聯
  `{s3_url}/300/webp/{hash}.webp`（冇就 `wm-cdn…&h=300`）；置業 `photos[0]&h=300`
  （會 302 去 `wmc.hkp.com.hk`）；利嘉閣 `?width=256`。新 host 要加 `_headers` CSP `img-src`。
- 「🔔 追蹤加減價」→ `/app?track_name=<屋苑>#register`：登記頁出提示；登入後
  `runTrackNameHandoff()` 喺屋苑搜尋框填好個名出結果，**唔自動追蹤**（同名／分期多，
  揀錯會食咗免費名額）。新用戶會等偏好 popup 閂咗先出。
- 搜尋記錄：只係 Workers Logs（`{"pubsearch":…}`），唔寫 D1。
- **地區篩選**（`area`，19 區）：id＝美聯／置業 `subregion_ids`（10xx 港島／20xx 九龍／30xx 新界；
  將軍澳係獨立一區 2010，西貢 3010）。對照表 `PUB_AREAS`（worker）：
  - 中原：`hmas` 填返該區嘅細區 leaf code（178 個 leaf 全部人手歸區，一個 leaf 只屬一區，unit test 守住）；
  - 美聯／置業：直接 `subregion_ids=<id>`；
  - 利嘉閣：`locationId=hkp019,hkp020…`（逗號分隔 = 各 group 總和，實測 觀塘 179 + 九龍灣 310 = 489）。
    佢嘅 group 同中原差唔多（55 個），但 3 個 group 跨區（鑽石山|黃大仙|九龍城、深井|青山公路）→ 兩區都包，
    所以利嘉閣結果會略多少少。改分區（地產網加／改 group）要重做對照表：
    `GET api/location?locationId=cc5d58f7-5de0-43ab-9724-e99203ebdffa`（住宅）→ 4 個大區 →
    `?locationId=<大區>&limit=100`（每頁預設 10，要加 limit）。
  - 前端 `<select>`（search.html／index.html）＋ `public-search.js` 嘅 `AREAS` 要同 worker 對得上。
- 未做：跨網同一單位合併、「有歷史記錄」標記。

## 心儀樓盤（2026-10-12）

放盤卡（買盤／租盤卡片 view）右上角 ♡，撳咗收藏；首頁 tab「♥ 心儀樓盤」列出所有收藏。
- 表 `listing_favourites`（account_id, estate_id, deal S|R, ref_no＝嗰個來源嘅 ref, refs JSON＝[ref],
  snap JSON＝收藏嗰刻由 DB 攞嘅快照（sources 淨係一個）, fav_price）；UNIQUE(account_id, deal, ref_no)，重覆收藏冪等。
  **唔合併**（2026-10-13 用戶決定）：撳合併卡 ♥ ＝每個來源各存一行；舊版合併行喺 `GET` 時 lazy 拆開。
- API（登入）：`POST /api/favourite-listings {estate_id, deal, refs[]}`（要 `canReadEstate`、ref 要真係喺嗰個屋苑；
  快照一律由 DB 攞，唔信 client）、`DELETE ?ref=&deal=`（合併卡 ♥ 會逐個 ref 打）、`GET`（列表＋最新價＋下架）、
  `GET /refs`（♡ 狀態，app 啟動時攞一次）。上限 `sec_fav_listings_max`（200，免費收費一樣）。
- 下架判斷：該 ref 最後見到嘅 snapshot_date ≠ 該來源最新一次 sync 日；每行淨係一個來源，所以該來源唔見＝下架。
  列表每個 ref 逐個 seek（`idx_*_estate_ref`），唔掃歷史。
- 前端：`favBtnHtml()`／`toggleFavListing()`／`loadFavListings()`；表格 view 暫時未加 ♡（只喺卡片 view）。
- 搜尋結果（app 內嵌搜尋）都有 ♡：`POST /api/favourite-listings/external`，ref_no＝原網站 URL，estate_id=0；
  快照由 client 傳所以逐欄 sanitize＋host 白名單；唔判斷下架／升跌。
- **分享心儀樓盤**：tab 入面每張卡有 checkbox＋「全選」＋「📤 Share」（multi-select）。**純 client 端**：彈窗直接出文字
  （`_favShareText`：「🏠 屋苑 座 樓層 室」＋每個來源嘅「中原：原網站連結」），俾 WhatsApp／複製／系統分享；
  **唔建立搵樓日記分享連結、冇伺服器 route**（用戶決定：佢要分享嘅係原網站連結，唔係我哋嘅頁；唔包價錢／相）。
  舊版（2026-10-12）嘅 `viewing_shares.kind='fav'` 已拆走，公開 route 對 kind='fav' 一律回 gone。

## 睇樓記錄分享（2026-10-12）

用戶將自己嘅睇樓記錄分享俾人睇，對方唔使登入：`/share#<token>`（`frontend/share.html`）。
- 入口：睇樓記錄卡 📤（單個）；睇樓日記日期卡「📤 分享今日睇樓日記」（嗰日 ≥2 個盤先出）。
- 分享視窗揀 opts：相片／價錢／評分（預設開）、備註（預設關）。建立後：複製連結、WhatsApp（wa.me）、
  複製文字（`_shareText`）、更多（`navigator.share`）。改 opts 要重新建立（伺服器按 opts 回欄位）；
  同一組記錄＋opts 重覆建立會用返舊連結。
- **永久有效**直到用戶喺 ⚙️ 設定「我分享過嘅連結」取消（`revoked_at`）；**實時**（改記錄對方見新，刪記錄即消失）。
  唔記開過幾多次（用戶決定，慳 D1 寫入）。免費／收費一樣，上限 `sec_share_max_links`（500，防濫用）。
- 表：`viewing_shares`（account_id, token UNIQUE, kind viewing|day, label, viewing_ids JSON, opts JSON, revoked_at）。
- API：登入 `GET/POST /api/shares`、`DELETE /api/shares/:id`；公開 `POST /api/public/share {t}`、
  `POST /api/public/share/photos {t, viewing_id}`（相撳先載，唔一次過回幾 MB）。規矩見 CLAUDE.md。
- 欄位白名單 `shareViewingPayload()`（有 unit test 守住唔會回 hs_price／linked_ref_no 等分析欄位）。

## 對應放盤相片存檔（收費版，2026-10-11）

睇樓記錄撳 ✓ 確認對應放盤 → 背景將個盤嘅相存落 **R2**（`env.PHOTOS`），代理落咗架都睇得返。
- **相唔入 D1**：D1 免費 500MB（當時用咗 88MB），一個盤 15 張已經 1–3MB，幾百個盤就爆。
  D1 淨係記索引 `listing_photo_archive`（account_id, viewing_id, ref_no, seq, full_key, thumb_key, bytes）。
- **尺寸靠地產網 CDN**（Worker 冇得自己壓圖，CPU 10ms）：`archiveVariants()`——中原 hkais
  `w=800&quality=75`（大圖）／`w=400&quality=70`（縮圖），**實測因相而異：60–145KB／30–40KB**；
  美聯 wm→wm-cdn、置業 wm.hkp 用 `h=600`／`h=300`。利嘉閣：`api/post?postNo=<盤號>` 回單個盤連 `attachments`
  （混有 VR 封面、YouTube 縮圖，只取 `resourcecdn…/rcdrive/ownerships/` 實相），`?width=800`／`?width=256`
  （實測 ≈50–70KB／≈10KB；詳情頁 HTML 係 JS 畫，淨得封面）。利嘉閣 JSON API 有 per-IP 限流，429 就回 0 張＋前端提示重試。
- R2 key：`a/<account>/<viewing>/<ref>/<seq>-f|-t`。
- Endpoints（全部 auth、scope account）：`POST /api/viewings/:id/archive-photos {ref_no}`（收費版、
  ref 要已 ✓、idempotent、上限 `sec_photo_archive_max_listings` 個盤＝200、每盤 `sec_photo_archive_per_listing`＝15 張）；
  `GET /api/viewings/:id/archived-photos?size=thumb|full&ref=`（data URL，降級咗都睇得返自己存過嘅）；
  `DELETE …/archive-photos?ref=`（取消 ✓ 時）；刪睇樓記錄會連 R2 一齊清。
- 前端：`buildMatchCell` 喺 ✓ 咗嘅盤下面留 `.vw-arch` 位，`fillArchiveStrips()` 填「📷 已保存 N 張」＋縮圖列，
  撳縮圖用 `viewImgFull('arch:vid:ref')` 睇大圖；免費用戶見 🔒 提示。
- **冇 PHOTOS binding（R2 未開）→ 成個功能自動停**（GET 回 unavailable、POST 503，前端靜靜唔顯示）。
- **開通步驟**：① Cloudflare dashboard 開 R2（要加付款方式，免費額度內唔收費）；
  ② `npx wrangler r2 bucket create propwatch-photos`（test：`propwatch-photos-test`）；
  ③ `wrangler.toml`／`wrangler.test.toml` 加 `[[r2_buckets]] binding = "PHOTOS"` + `bucket_name`；④ deploy。

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

### 每日 sync 範圍（2026-09-29 起）

Drip sync 唔再對「有人訂閱」嘅屋苑逐個每日做，改成：
- **每日全做**：有「付費（或 admin）帳戶」標咗 ★ 最愛嘅屋苑（`getDailySyncEstateIds`）。
- **輪住做**：其餘生效中屋苑，每日 `ceil(N/7)` 個（最舊優先）；≥7 日冇成功 sync／從未 sync 過嘅一定做，
  所以**每個屋苑最多隔 7 日更新一次**（`pickRotationEstates`，有 unit test 模擬 30 日）。
- **新屋苑第一次即日補齊**：`/api/track` 加訂閱後 `syncPlanAddEstate` 塞入今日 plan，drip 下一輪即做。
- 今日 plan 存 `settings.sync_plan`（`{date, rotate:[ids]}`），每日第一次算一次。手動「立即同步」照舊做全部。
- **最愛上限**：`accounts.max_favourites`（NULL＝跟全局 `sec_max_favourites`，預設 10），只有 admin 改得
  （`POST /api/admin/max-favourites`，喺 ⚙️ 設定→用量統計嘅「最愛」欄）；`POST /api/estates/:id/favourite` 後端擋（409）。

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
  default 10/min), `sec_ip_rpm` (every /api/* request per IP regardless of
  token, default 600/min — stops rotating fake tokens), `sec_api_rpm`
  (additionally per Bearer token, default 240/min). Checked **before** the
  `ensure*` D1 calls so a 429 costs no D1 reads. Because counters are per
  isolate, a client spread over many isolates can exceed the nominal limit.
  Change via D1:
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

## 朋友屋企：過往成交抓取狀態（2026-10-13）

`friend_homes.txn_status`：`ok`＝有成交／`none`＝中原確認冇（Centadata `DetailByUnitCode` 回 404，或單位唔喺佢表）／
`error`＝抓失敗（網絡、限速、5xx）。**error 唔會當「冇記錄」存**（之前一律存 `'[]'`，暫時出錯會永遠顯示「冇記錄」）：
- `fetchUnitTxns` 回傳 `failed`（任何非 404 嘅外抓失敗）；`enrichFriendHome` 用 COALESCE，error 唔覆蓋舊 `past_txns`／`est_url`。
- 前端 `fhAutoEnrich` 自動重試（每個 session 每個盤最多 3 次，6s／12s 退避，用戶唔使撳 🔄）；用盡就顯示「暫時抓唔到，下次打開會再試」。
- `txn_status IS NULL` 且成交為空嘅舊資料，打開 tab 時會重驗一次（得出 ok／none／error）。
- 注意：越秀廣場等個別單位中原本身冇成交（約四分一單位 404），`none` 係正常結果。
- **恒生估值同樣自動重試**：`hsLookup` 回 `reason:"error"`（keywordsearch／座表／valuation 5xx、429、403、連線錯；404／errorCode 仍然係 `no_unit`）。
  `friend_homes.hs_status='error'`（或舊資料 NULL 且冇估值）→ 前端同過往成交共用重試次數（3 次）；
  error 唔覆蓋之前查到嘅 hs_price／hs_area／hs_date（SQL CASE），真係「恒生冇」先清走舊值。
  其他 caller（每日掃描、手動查估值）淨係讀 `v`，行為不變。

## 每日 email 一日兩封（2026-10-17 查到）

2026-10-14 中午起，Cloudflare 將每個 cron 觸發點喺**兩個機房**（AMS＋SIN）各行一次（GraphQL `workersInvocationsAdaptive`
dimension `coloCode` 見到；之前只得 SIN，每小時 invocation 30→60），設定冇變（`schedules` 仍然只得 `*/2` 同 `0 1`）。
09:00 email task 因而跑兩次，admin 帳戶收兩封一樣嘅信。處理：`sendDailyEmail` 寄之前用 `daily_email_log(account_id, day)`
`INSERT OR IGNORE` 原子認領當日名額，輸咗就唔寄（result 記 `duplicate`）；寄失敗就放返名額。`/api/admin/run-email-task`
用 `force` 唔受限，手動單一帳戶／overrideEmail 都唔受限。
⚠️ drip sync（`*/2`）同樣被雙重觸發，兩個 invocation 會撞同一批 pending 單元（idempotent 但白撞 portal、食雙倍 D1／CPU）；
暫未處理。查法：`workersInvocationsAdaptive` 加 `coloCode` 維度。
