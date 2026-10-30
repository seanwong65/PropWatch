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
| Deploy frontend | `bash tools/deploy-frontend.sh` |
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
  **改價記錄＝收費功能**（2026-10-20 用戶決定）：`GET /api/favourite-listings` 只喺 `isPaidSession` 先查先回 `history`，免費帳戶
  `history:[]` ＋ 頂層 `history_locked:true`（server 端 gate，唔係淨係前端收埋）；前端見 `history_locked` 就喺卡上顯示「🔒 改價記錄 · 收費功能」，撳落去彈升級 modal（`showUpgrade('心儀樓盤改價記錄')`）。
  **改價記錄**（2026-10-20）：`GET /api/favourite-listings` 每個收藏回 `history:[{d,p}]`——該 ref 喺 `listing_price_history`／`rental_price_history`
  入面「價錢同上一日唔同」嗰日（窗口函數 LAG，加第一日，最多 20 點）；卡片顯示「改價記錄：06-28 $570萬 → 07-07 $560萬 ▼1.8% …」，
  未改價顯示「未有改價記錄」；搜尋結果收藏（estate_id=0）冇 DB 數據唔顯示。
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
`INSERT OR IGNORE` 原子認領當日名額，輸咗就唔寄（result 記 `duplicate`）；寄失敗就放返名額。認領有過期：`sent_at` 寄完先填，認領後 10 分鐘仍未寄
（worker 被殺）可由另一個 invocation 原子接手重寄（`DAILY_EMAIL_CLAIM_TTL_MIN`）；`sent_at` 有值永不重寄。`/api/admin/run-email-task`
用 `force` 唔受限，手動單一帳戶／overrideEmail 都唔受限。
drip sync（`*/2`）同樣被雙重觸發：兩個 invocation 同時揀同一批 pending 單元，每個單元被抓兩次
（實測每日 subrequest：10-14 前 ~260，10-16 ~650，10-17 ~1100）。處理（2026-10-17）：`acquireDripLock` 用 D1 租約鎖
（`settings.drip_lock_until`，100 秒；`INSERT … ON CONFLICT DO UPDATE … WHERE` 原子；唔主動釋放，租約 < cron 間隔 120 秒），
拎唔到鎖就收工（console.log「[drip] 跳過」）。email watchdog／summary／恒生掃描都喺鎖入面，一併唔會重覆。
查法：`workersInvocationsAdaptive` 加 `coloCode`／`datetimeFiveMinutes` 維度，睇 AMS 同 SIN 嘅 subrequests。

## App icon（2026-10-21）

- **完整版**（屋＋香港天際線＋放大鏡＋走勢線＋書籤，AI 生成）：`docs/brand/app-icon-master-1024.png`（原圖，唔 deploy）；
  由佢 `sips` 縮出 `frontend/icons/icon-512.png`、`icon-192.png`、`frontend/apple-touch-icon.png`（180，iOS 要求無透明）。
- **2026-10-21 更正**：用戶要求**全部位置都用完整版**（唔用簡化版）：header／登入視窗／首頁／各公開頁 logo 用 `icons/icon-192.png`，
  瀏覽器分頁用 `icons/favicon-32.png`、`favicon-16.png`＋`favicon.ico`（16／32／48，由 master `sips` 縮）；簡化版 SVG 收埋喺 `docs/brand/favicon-simplified.svg`（唔 deploy）。
- `frontend/manifest.webmanifest`（PWA：start_url `/app`、theme `#1270ac`、background `#eef6fd`；purpose 只用 `any`，唔做 maskable——完整版構圖未留夠 safe zone）。
- 11 個 HTML 嘅 `<head>` 已加 `favicon.ico`、`apple-touch-icon`；`index/app/search` 另加 `manifest`；`_headers` 加 manifest 嘅 Content-Type；首頁 JSON-LD `logo` 改指 `icon-512.png`。
- 顏色（取樣自完整版）：背景 `#5dbbfd`→`#035ece`，琥珀 `#ffd34d`→`#f78f18`，鏡片 `#ddedfc`。比網站 UI 品牌藍 `#1270ac` 鮮艷（用戶揀 A：保持原色）。
- 瀏覽器會死 cache favicon：換 icon 後要硬重新整理或清 cache 先見到新嘅。

## SEO 更新（2026-10-22）

- 首頁：title／description／OG 改為以「四大地產網一次搜（買盤租盤）＋放盤日數、減價紀錄追蹤」做主打；JSON-LD WebApplication featureList 補齊新功能，加 `FAQPage`（同頁面可見嘅「常見問題」6 條 `<details>` 一致）；功能介紹加 2 張卡（四網搜尋、心儀樓盤改價記錄，截圖 `images/feat-search-726.jpg`、`feat-fav-707.jpg`，只截自己 UI，冇地產網相片）。
- `/search`：title／description 加買盤租盤、19 區、價錢排序、居屋未補；頁底加靜態說明段 `.ps-seo`（用法、19 區連結 `/search?area=…`、租盤連結、FAQ 5 條＋JSON-LD FAQPage）；canonical 仍係 `/search`。
  `public-search.js`：冇條件時唔再用 JS 改 `document.title`（Google 會 render JS，會蓋過 SEO 標題）。PS_VER `20261022a`。
- 新教學：`/guides/viewing-checklist`（睇樓清單）；guides 首頁、首頁教學區、about 加連結；sitemap 加新頁＋更新 lastmod。
- 文案事實要同功能一致：免費 3 個屋苑／15 個睇樓記錄（`sec_free_*`）；改價記錄、時間軸、走勢圖、每日 email 係收費；價錢唔寫死（Stripe 動態）。
- 2026-10-22（續）：分享預覽圖改用 `images/og-default.jpg`（1200×630，源檔 `docs/brand/og-default.svg`，`qlmanage` 渲染：SVG 要做正方形 1200×1200、內容置中再 `sips -c` 中間 630 行，否則 qlmanage 會放大）；全站 og:image／twitter:image／guides JSON-LD image 統一。
  新教學：`/guides/negotiation`（點樣講價）、`/guides/hos-premium`（居屋未補地價）、`/guides/renting-checklist`（租樓注意事項）；guides 首頁、首頁教學區、sitemap 已加。政策／稅率類內容加咗「以官方最新公佈為準」。
- 地區專頁**樣本** `/area/sha-tin`（2026-10-22）：`noindex`、未入 sitemap、冇內部連結，等用戶確認格式。結構：H1＋簡介、嵌入即時搜尋（`PublicSearch.mount(el,{embedded:true, hook:true, initial:{area:"3017"}})`，`opts.hook` 新加：嵌入模式都顯示免費登記提示）、分區／港鐵站／屋苑表（屋苑連 `/search?kw=`）、買樓注意、租盤同附近地區連結、FAQ＋JSON-LD。PS_VER `20261022b`。
- 教學第二批（2026-10-22，10 篇）：saleable-area、buying-process、extra-costs、bank-valuation、old-building、floor-and-orientation、unauthorised-works、transaction-records、h-vs-p-mortgage、rent-or-buy。由 scratchpad 模板（同現有 guides 一樣嘅 head／JSON-LD／CTA）生成；guides 首頁改做 4 個分類；首頁加「睇晒全部 16 篇」；sitemap 22 個 URL。政策、稅率、銀行做法一律寫「以官方／銀行最新公佈為準」，數字例子標明「示意」。
- **Email 預覽機制**（2026-10-22）：`sendQueuedEmailPreview`（drip cron 持鎖後行）。本機生成 HTML，經 wrangler 寫 `settings.email_preview_html` 同 `email_preview_queue`（`{"account_id":N,"subject":"…"}`），2 分鐘內寄出並刪 key；**只寄 admin 帳戶自己 email**、HTML ≤ 400KB。用嚟寄每週摘要等新 email 嘅樣本。
- 沙田專頁：簡介改寫成具體內容；分區表同「要留意」排喺即時搜尋之前（用戶要求介紹排先）。首頁「睇晒全部買樓教學」唔顯示篇數。

## 地區專頁（2026-10-22）

- `/area/`（總覽，港島／九龍／新界／離島）＋ 19 區 `/area/<slug>`（同 `/search` 嘅 19 個 area code 一一對應）。已入 sitemap（42 個 URL），`/search` 嘅地區連結、全站 footer「各區二手樓」都指去呢度。
- 生成器：`tools/area/gen.py`（讀 `tools/area/data.py`），改內容就改 data 再行 `python3 tools/area/gen.py`（輸出去 `frontend/area/`，含共用 `area.css`）。**唔好直接改 `frontend/area/*.html`**，會俾下次生成蓋過。
- 屋苑例子全部用中原即時搜尋核對過喺嗰區有放盤（`tools/area/verify.json`）；港鐵站同分區係人手寫，改之前核對。
- 頁面：簡介 → 分區／交通／屋苑表（屋苑連 `/search?kw=`）→「喺X買樓要留意乜」（成段一個 `<details>`）→ 即時買盤（`PublicSearch.mount(el,{embedded:true,hook:true,initial:{area}})`）→ 租盤＋附近地區 → FAQ（JSON-LD FAQPage）。

## Google Search Console 驗證（2026-10-22）

`frontend/googledfea0625fe9a57c1.html.html`（**故意兩個 .html**）：Cloudflare Pages 會將真正嘅 `x.html` 由 `/x.html` 308 轉去 `/x`，Google HTML 檔驗證唔接受轉址；改名之後 `/googledfea0625fe9a57c1.html` 直接回 200、內容一字不改。**唔好刪亦唔好改名**，刪咗 Search Console 會失去驗證。
- 租盤專頁（2026-10-22）：每區另有 `/area/<slug>-rent`（`gen.py` 嘅 `page(d, "R")`，租樓角度內容喺 `data.py` 嘅 `RENT`，加兩項通用租樓提示；即時搜尋 `initial:{deal:"R", area}`；屋苑連 `/search?deal=R&kw=`）。買盤頁同租盤頁互相連；總覽頁每區有租盤連結；sitemap 61 個 URL；footer 改叫「各區樓盤」。

## 每週摘要（2026-10-23，收費版）

- 逢**星期六 10:00 HKT**（cron `0 2 * * 7`＝`WEEKLY_CRON`（⚠️ Cloudflare 星期係 1–7，1＝日、7＝六；2026-10-23 寫 `6` 變咗星期五誤發一次，已改），同 wrangler.toml 要一致）寄 `worker/weekly.js` 生成嘅 email；**只計 ⭐ 最愛屋苑**。免費用戶冇（用戶決定，唔做簡化版）。
- 內容：一句總結、你留意緊嘅盤（心儀樓盤／睇樓記錄對應放盤）**本週有改價或下架先出**、值得留意（合睇樓偏好＋低過成交中位／長放再減）、最愛屋苑市況。冇「同座成交對比」。上週冇 snapshot 就寫「數據累積中」。
- 三層：`loadWeeklyInputs`（讀 D1，全部 scope 返 account）→ `computeWeekly`（純計算，`tests/weekly.test.js`）→ `renderWeeklyHtml`（esc）。
- **數據保護**：最愛屋苑最新 snapshot 超過 `WEEKLY_STALE_DAYS`(1) 日前就唔計；全部過期就唔寄（`skipped: stale_data`）並通知 admin。
- 週六有開 weekly＋有最愛屋苑嘅帳戶，每日 email 當日唔寄（`sendDailyEmail` 嘅 `satSkipWeekly`）；冇最愛屋苑嘅照寄每日。`force`／單一帳戶手動唔受影響。
- 防重覆：用 `daily_email_log`，day＝`weekly-<日期>`；失敗放返名額。週六 11:00 watchdog（`checkWeeklyCronWatchdog`，由 drip cron 觸發）未見 `cron_last_weekly_start` 就補跑。heartbeat：`cron_last_weekly_start/done`。
- 開關：`accounts.weekly_opt_in`（預設 1），⚙️ 設定（只收費用戶見到）；`email_opt_in=0` 一律唔寄。退訂連結 `/api/unsubscribe?token=…&kind=weekly` 只關 weekly（白名單，其他值當全部）。
- 手動驗證：`POST /api/admin/run-weekly-task`（admin）`{account_id, preview:true}` 回 subject／html 唔寄；`{account_id}` 寄嗰個帳戶；冇 account_id＝行 cron 正式路徑（一週一封）。
- Phase 2（未做）：估值／朋友屋企、租金回報、睇樓進度、app 內存檔。

## 中原十大屋苑（2026-10-23，俾公開樓市速報用）

- 十個：太古城(1)、映灣園(2)、嘉湖山莊(6)、黃埔花園(16)、麗港城(30)、康怡花園(53)、海怡半島(54)、美孚新邨(55)、新都城(56)、沙田第一城(57)。名單係由週報推斷，非中原官方（用戶揀「以中原為準」）。
- 掛喺**系統帳戶 `system-market`（id 17，role=`system`，冇 email、唔可以登入）**名下，全部 `is_favourite=1`，所以每日 sync。`getDailySyncEstateIds` 淨係呢度認 role=`system`（唔食 paid／admin 嘅估值掃描、email、tier gate），唔好將 system 加入其他 `a.role='admin'` 條件。
- 唔掛 admin 帳戶：否則會塞滿用戶自己 sidebar、每日 email 同每週摘要。
- 舊 estates row 有幾個係遺留（映灣園／嘉湖山莊原本 is_disabled、數據停喺 6–8 月；麗港城(42)／太古城(46) 係冇數據嘅重複 row，唔郁）。歷史由 2026-10-23 起累積，所以第一份速報「較上週」要等一個星期。
- ⚠️ **D1 寫入量（2026-10-23 教訓）**：D1 免費版每日 100k rows written。一個盤每日 sync 約寫 12 行（listings INSERT OR REPLACE 約 7＋listing_price_history upsert 約 5.4，連 index）。十大屋苑一日約 4,600 個盤 ⇒ 若全部每日 sync，約 +60–70k writes/日（加上原有 ~12k），長期處於 70–80%＋，一有 spike 就爆。首日加屋苑初次 sync 一個鐘寫咗 ~106k。
  所以 `system-market` 名下屋苑**行普通輪流 sync**（約每 5 日一次，約 14k writes/日）；速報只需要「本週 vs 上週」，唔使每日。`getDailySyncEstateIds` 已經**唔再**認 role='system'（即使 account_estates.is_favourite=1 都唔會每日 sync）。要每日 sync 要先確認 D1 額度／升級 Workers Paid，再加返 role 條件。
  當日爆額度嘅表現：`wrangler d1 execute` 回 code 7500「exceeded D1's free tier daily row write limit」，所有寫入（login session、sync、email 認領）失敗，讀取照常，UTC 午夜（HKT 08:00）重置。
  查 D1 用量：GraphQL `d1QueriesAdaptiveGroups`（dimensions.query、sum.rowsRead/rowsWritten，`databaseId` 過濾），用 wrangler OAuth token；`wrangler d1 insights` 喺 3.x 回空。

## 收費分界／價錢更新（2026-10-24）

- **朋友屋企免費版都可用**（用戶決定）：移除 `/api/friend-homes*` paywall；改為數量上限，POST 時檢查：免費 `sec_free_max_friend_homes`（預設 3）、收費 `sec_paid_max_friend_homes`（預設 30），超出免費上限回 402（彈升級）。原因：每個朋友屋企會外抓成交＋恒生估值。
- **年費 HK$300 → HK$400**：經 `POST /api/admin/billing/plans {interval:"year", amount:400, effective_from:"2026-10-24"}` 新開 Stripe Price（Live mode），舊客 grandfather；月費維持 HK$38。年費相對月費平 ~12%。
- 升級 modal 對比表：追蹤屋苑收費欄寫「10+」；「抵買雷達」已隱藏（tab 食 D1 額度），對比表改寫「相對市價、估值」。
- 「上盤日期 🔒」改成藍色膠囊，要似個掣。

## 免費 vs 收費：逐項對過 code 嘅實際分界（2026-10-24 核實）

收費才有（server 端 paywall／gate）：放盤時間軸（first_seen／放盤日數／改價次數／原價／自動下架）、進階搜尋嘅放盤日數／減價篩選、呎價走勢圖（trends／market-index／租盤 rental-trends）、心儀樓盤改價記錄、歷史動態、睇樓記錄分析（/api/viewings/comps、estate-comps＝相對市價／成交對比）、恒生估值（hangseng-valuation*）、對應放盤相片存檔（archive-photos）、每日 email、每週摘要、抵買雷達（tab 已隱藏）。
有數量上限（免費 vs 收費）：追蹤屋苑（sec_free_max_estates 3／sec_paid_max_estates 15）、睇樓記錄（sec_free_max_viewings 15、每記錄相 sec_free_max_viewing_imgs 10；收費無限）、朋友屋企（sec_free_max_friend_homes 3／sec_paid_max_friend_homes 30）。
兩邊都有：四網公開搜尋、放盤列表（今日 snapshot）＋篩選、成交記錄、市場溫度、今日動態、睇樓記錄（有上限）、類近成交。
⚠️ **Telegram 唔係用戶功能**：只係 admin 運維警報（TELEGRAM_CHAT_ID 單一收件人），升級頁／宣傳唔可以寫「Telegram 推送」。


## D1 往返延遲（2026-10-25）— 「載入詳情…」轉好耐嘅真因
- D1 主庫喺 **ENAM（北美東部）**（`wrangler d1 info propwatch-db` → running_in_region），worker 喺香港／台灣 edge 行 →
  **每條 D1 query ≈ 200ms 跨洋往返**。單一 request 連續做 N 條 query 就 = N×200ms。冇 read replication、冇 Smart Placement。
- 量度（正式站，用戶瀏覽器）：401 都要 ~520ms、最簡單嘅 `/api/config` 1.1s、`/api/viewings?estate_id=`（得 1 條記錄）5s。
- 元兇：(1) 入口每個 request 行 `UPDATE accounts SET role='admin'…` ＋ `SELECT multi_account_migrated`（2 次往返）；
  (2) 十幾個 `ensure*` 每個 request 都行 `CREATE TABLE IF NOT EXISTS`（`ensureRentalTables` 單獨 15 條）；
  (3) `getConfig` 每次先 CREATE settings；(4) viewings handler 每次試 `ALTER TABLE`（已有欄位照樣失敗一次）。
- 修法：`onceDb()`／`ddlOnce()`（每個 isolate 一次，失敗唔記）；admin promote 60 秒一次；migrated flag 記住；viewings 入面 getConfig／相片數同其他 query 並行。
- ⚠️ **新增 `ensure*` 一律經 `onceDb`**，唔准每個 request 重行 DDL。寫新 handler 要數「連續幾多次 await D1」，能夠 `Promise.all`／`db.batch` 就合併。
- 未做（要用戶決定）：Smart Placement（worker 搬去 D1 附近，但 scrape／公開搜尋會由美國出 IP，可能被地產網封）、
  D1 read replication（要改用 Sessions API＋處理寫後讀一致）、authenticate session 短 cache（令登出／降級遲幾秒生效）。
- **Schema 版本閘**（`SCHEMA_VERSION` ＋ `settings.schema_version`）：cold isolate 之前要行 ~45 條 DDL（≈7 秒），而家版本一樣就全部跳過（cold 只多 1 次往返）。
  ⚠️ **加／改任何 `ensure*`（新表／欄／index）一定要 bump `SCHEMA_VERSION`**，否則 production 唔會行嗰段 DDL。`onceDb`／`ddlOnce` 要放喺檔案頂（module 載入時已經會用）。

## 免費版恒生估值試查（2026-10-25，用戶改為「每個盤查一次」）
- 免費用戶：**每個單位手動查一次**（睇樓記錄詳情「試查估值（每盤 1 次）」，撳先有確認框）；**查到定查唔到都算一次**，之後唔再俾查。唔自動查（收費版先有自動：儲存睇樓後、今日動態）。
- 記錄喺 `hs_free_tries(account_id, estate_id, unit_key, result)`，PK 即係原子鎖；`unit_key` 由睇樓記錄座／層／室砌（`hsUnitKey`），所以刪咗再加同一單位唔會重置。`result`：`ok`／`nodata`。我哋自己出錯（throw）先退返（刪 row）。
- 另有帳戶總上限 `sec_free_hs_trials`（預設 20，防農場；超出 402 唔記錄）。⚠️ getSecCfg 有 60 秒 isolate cache，改設定最多遲 60 秒。
- Server：`GET /api/hangseng-valuation?…&trial=<viewing id>` 驗 viewing 係自己＋單位一致；`/api/viewings*`（免費）回 `hs_tried`（null／ok／nodata）；`/api/config` 回 `hsTrialCap`、`hsTrialsLeft`（總上限仲剩幾多）。
- 前端：有 `hs_price` 顯示估值；`hs_tried` 且冇價 →「查無資料（免費版每盤查一次，已用）」；總上限用完 →「估值 🔒」；對比表免費欄「每盤試 1 次」、收費欄「自動查」。
- 加咗新表 → `SCHEMA_VERSION` 已 bump 到 2026-10-25b。

## 座數（睇樓記錄）可留空（2026-10-25）
- 單幢屋苑冇座數。表單座數可選；**留空儲存時前端用屋苑名做 `block`**（production 已有 5 條咁嘅記錄，顯示會隱藏同屋苑名一樣嘅 block；放盤配對用 `building_name`＝屋苑名）。
- 修咗：成交比對 SQL 之前將 block 補成「X座」，單幢屋苑成交嘅 `building`＝屋苑名（冇「座」）永遠對唔到 → 上手成交、「你睇過嘅盤有新成交」email／今日動態都收唔到。而家 `t.building IN (X座, block)`（4 處：viewings GET 兩個 subquery、daily email 買／租、今日動態）。
- 仍然冇處理：block 完全 NULL／空（舊 API 或手改）嘅記錄在 comps 唔會判 sold、frontend 當「座未填」——production 0 條，新 UI 唔會產生。

## 每週摘要：待跟進 section（2026-10-25，收費版）
- 同 app「待跟進」同一套規則（`weeklyTodos`，純函數有測試）：欠座／樓層／室／睇樓價（租盤＝睇樓租金）、未對應放盤（睇樓超 `todo_link_max_days`，預設 30 日唔再提）；已成交、用戶 ✕、全部放盤都 ✕ 過（dismissed_refs）唔提。最多列 5 條，其餘寫「另有 N 個」；冇待辦就唔出。
- 用戶「✕ 唔再提醒」以前只存 localStorage，現在同步去 `settings.todo_dismissed_<accountId>`（`POST /api/todo-dismissed`，只收自己嘅 viewing id，最多 1000）；`/api/viewings/all`、`/api/viewings?estate_id`、`/api/viewings/comps` 回 `todo_dismissed`，前端載入時雙向合併（舊本機記錄會一次過補送上 server）。
- loadWeeklyInputs 用 `v.*`（dismissed_refs 係 lazy ALTER 欄位）＋ EXISTS 查成交（`building IN (X座, block)`）判 sold；讀唔到就唔出 section，唔影響成封信。

## 冇更新就唔寄 email（2026-10-25）
- **每日**：`dailyIsEmpty`——筍盤、睇過嘅盤變動、新放盤、成交、下架、租盤動態任何一項有就寄；售價變動跌／升幅 < `email_min_move_pct`（細幅，email 本身都唔逐條列）單獨唔算更新。冇就唔寄。
- **每週**：`weeklyIsEmpty`——新盤＋減價＋新成交＋你睇過嘅盤變動 全部 0 **而且冇待跟進** 先唔寄（用戶 2026-10-25 改為「有待跟進都寄」）。
- 只限 cron 路徑（`guard`）；admin 手動單一帳戶／`preview`／`force` 照寄，方便測試。`/api/admin/preview-daily` 回 `empty`，睇到 cron 會唔會寄。
- 回報用 `empty`（唔係 `skipped`）——`runDailyEmailTask`／`runWeeklySummaryTask` 嘅 `skipped` 會觸發 admin alert（扣數出事／跳過）。`cron_last_email_done`／`cron_last_weekly_done` 嘅 detail 多咗 `empty` 數目。
- 每日跳過時照 `markDailyEmailSent`（當日已處理）；每週保留 claim 唔重試。

## 本週變動（卡片 → 動態頁）（2026-10-25，收費版）
- ⚠️ **彈出面板已拆走**（用戶決定）：側邊欄卡片「本週：新盤 N・減價 N・下架 N」每個數字可撳 → `goWeekDynamic(estateId, tab)`：返首頁（喺屋苑頁會重畫；已經喺首頁就唔重畫）→「動態」tab →「本週」→ 切去對應分頁（新盤／減價／下架；數字係 0 就用第一個有內容嘅分頁）→ 滾動並閃一下該屋苑組（`#wkg-<id>`，`.wk-flash`）。撳整行（非數字位置）＝預設分頁。關閉側邊欄。
- 本週頁：**「正睇緊嘅屋苑」會記住**（`_weekFocusId`，由卡片撳入嚟設定）：切頂部分頁時自動跳返嗰個屋苑組，sticky 列下面有 `📍 屋苑　N 個 ✕` 標籤（可取消；呢個分頁冇嘢就寫「本週冇X」）；跳轉一律瞬間（smooth 動畫會被版面變化打斷）＋350ms 後校正一次。**分頁列（新盤／減價／下架／新成交）sticky**（`top:56px`，貼住頂部 app 標題列）；**屋苑次序＝側邊欄次序**（最愛 ⭐ 先，再跟用戶自訂 sort_order，唔按變動多少排）；每個屋苑一組，標題撳一下收起／展開（`_wkCollapsed`），「屋苑頁 ›」入屋苑；每類每屋苑最多 60 條（`/api/week-changes?cap=60`），超出寫「共 N 個，列出頭 60 個」。
- `GET /api/estates/:id/week-changes`（單屋苑）仍然存在但前端冇用；計算全部喺 `estateStats.js`：`loadSnapshotPair`（卡片同本週共用）、`weekChangesFromSnapshots`、`weekTxnsFrom`、`computeWeekChanges`。條數＝卡片（本機 15 個屋苑逐個驗證）。刻意冇做「已成交」標籤：放盤樓層係低／中／高層，對唔到成交實際樓層。

## 動態：今日｜本週（2026-10-25）
- 首頁 tab「今日動態」改名「動態」，入面 `今日｜本週` 兩粒切換（`setDynMode`）。今日＝原本 `today-highlights`（免費／收費）；**本週＝收費版**，免費版顯示「本週 🔒」撳咗彈升級窗。🎯 偏好 chip 只喺今日顯示（CSS `.dyn-week`）。
- 本週＝`GET /api/week-changes?cap=30`：你追蹤中（未暫停）屋苑逐個用 `computeWeekChanges`（同卡片、單屋苑面板**同一套計算**，所以總和 = 卡片數字總和；本機 16 個屋苑逐個＋總和驗證一致）。按屋苑分組、新盤／減價／下架／新成交 四個分頁，屋苑標題／「撳睇全部」開單屋苑面板。
- `weekChangesCached`：按屋苑 isolate 記憶體 cache 10 分鐘（只跟 snapshot，同帳戶無關），單屋苑 route 同批量共用；失敗唔 cache。
- 歷史動態（`history-highlights`，月份、first_seen 計法）原樣保留，同「本週」計法唔同，唔再互相比較。

## 收費版到期／扣款失敗 email（2026-10-26）
- 之前：到期降級完全冇通知用戶（只有扣款失敗通知 admin）。而家兩封（`worker/lifecycle.js` 模板，帳戶通知，唔跟每日 email 退訂開關）：
  1. **已到期／已取消**（`notifyDowngraded`）：收費 → 免費嗰刻即時寄（webhook `subscription.deleted`、`applySubscription` 轉 free、對數、admin cancel／sync）；內容：資料全部保留、暫停咗幾多個屋苑（免費上限 `sec_free_max_estates`）、鎖住咩功能、重新訂閱指引。
  2. ~~即將到期提醒~~ **用戶決定唔做（2026-10-26）**，已拿走。
  3. **扣款失敗**（`invoice.payment_failed`）：通知用戶本人（以前只通知 admin）；每張 invoice 一次。
- 只寄一次：`settings` 一行做 claim（`lc_expired_<id>_<periodEnd>`、`lc_expiring_<id>_<periodEnd>`、`lc_payfail_<id>_<invoice>`）；寄失敗刪 claim 下次再試；續期後再到期有新 key 會再寄。
- `runLifecycleEmails` 搭每日 email cron（`runDailyEmailTask`，喺 `sendDailyEmail` 之前）：①**人手開通過期但冇人登入嘅帳戶主動降級**（以前只喺 `authenticate()` 有 request 先降級，過期仲收緊每日 email）②近 10 日內人手到期補寄到期信。`cron_last_email_done` detail 有 `lifecycle` 數目。
- Admin：`POST /api/admin/lifecycle-emails`：`{sample:true, kind:"expired|payment_failed"}` 寄樣本去自己 email；`{run:true, dry_run:true}` 睇邊個會被降級／寄信（`dry_run:false` 真行）。

## Stripe 客戶入口（Billing Portal）（2026-10-26）
- ⚠️ 發現：live 帳戶**冇任何 portal configuration**，「管理訂閱／發票」撳咗會報錯 → 用戶換唔到卡、取消唔到、睇唔到發票；扣款失敗一定停。
- 修：`ensurePortalConfig()` 用 API 建專屬 configuration（名「搵樓日記 客戶入口」）：開放**更新付款方式**、發票紀錄、`customer_update`（email／name）、**到期取消**（`at_period_end`＋取消原因）；唔開改計劃。id 存 `settings.stripe_portal_config`；`/api/billing/portal` 一律帶 `configuration`，存咗嘅被刪就自動重建。live id：`bpc_1UUUFtHaNxLrRvtWzYPTzZtb`（`GET /api/admin/billing/portal-config` 睇、`POST` 建／`{force:true}` 重建）。
- ⚠️ Stripe 帳戶同 iPointWeb 共用：呢個係帳戶第一個 configuration，Stripe 自動標咗 `is_default: true`。iPoint 如果有用客戶入口且冇指定 configuration，會見到呢個設定（之前係冇設定，本身開唔到）。
- 未做：用真實 customer 完整行過一次 portal（要有付費用戶）。第一個真實付費用戶出現後，登入 → ⚙️ 設定 → 管理訂閱／發票，確認見到「更新付款方式」。

## 防抄／保護（2026-10-27，A＋B＋C）
- **A. 前端 build**：`bash tools/deploy-frontend.sh` = `tools/build-frontend.mjs`（frontend/ → dist-frontend/：刪 HTML／JS／CSS 註解、terser 壓縮 inline 同獨立 JS（**唔改 top-level 名**，onclick／跨檔 function 照用）、clean-css；JS 字串入面嘅 `<!-- -->` 都刪；JSON-LD 同 Google 驗證檔唔郁；最後逐個 inline script `node --check`，錯就 exit 1）＋ pages deploy dist-frontend。app.html 624KB → 419KB。repo 入面 frontend/ 保持可讀。dist-frontend/、tools/node_modules/ 唔入 git。本機用 build 版跑過：收費／免費帳戶主要功能、屋苑頁、本週動態、升級窗、按揭計算機、設定、新增睇樓、/search 搜尋，零 JS 錯誤。
- **B. API 只經自訂域名**：app 嘅 production API 由 `propwatch-worker.johnwong777.workers.dev` 改做 `https://api.ws-techs.com`（受 Cloudflare 網域 WAF／限速保護；workers.dev 唔受）。worker：production 嘅 `*.workers.dev` 只接受 `/api/stripe-webhook`（Stripe 設定可能仲指住）同 `/api/unsubscribe`（2026-09-26 前嘅 email 退訂連結），其餘 404。test worker（IS_TEST_ENV）唔受影響。之後可以喺 Cloudflare 對 `api.ws-techs.com` 加 rate limiting rule（⚠️ 唔好開 Bot Fight Mode：會擋 Stripe webhook）。
- **C. 異常用量警報**：`trackUsage`（authenticate 之後，admin 唔計）isolate 記憶體累積，每 40 次／60 秒 flush 去 `api_usage`（日×帳戶次數）＋`api_usage_estates`（日×帳戶×屋苑）；今日超過 `sec_usage_alert_hits`（3000）或讀取屋苑數超過 `sec_usage_alert_estates`（25，404 嘅嘗試都計）→ Telegram 通知 admin（每帳戶每日一次，`settings.usage_alert_<day>_<aid>`）。`GET /api/admin/api-usage?day=` 睇排行。SCHEMA_VERSION → 2026-10-27a。
- ⚠️ **Cloudflare Pages 連住 GitHub 自動 deploy**（每次 push main 都會 build）。2026-10-27 之前 `root_dir: frontend`、冇 build 指令 → 每次 push 都將未壓縮原檔蓋過手動上載嘅壓縮版。已經用 API 改做：root 留空、build command `cd tools && npm ci && cd .. && node tools/build-frontend.mjs`、output `dist-frontend`。所以 push 同 `tools/deploy-frontend.sh` 兩條路都係壓縮版；`tools/package-lock.json` 一定要入 git（`npm ci` 要用）。
- **Cloudflare 限速規則（2026-10-27 已設）**：ws-techs.com → Security rules → Rate limiting rules → `api-rate-limit`：`(http.host eq "api.ws-techs.com" and starts_with(http.request.uri.path, "/api/") and http.request.uri.path ne "/api/stripe-webhook")`，按 IP，10 秒 60 次，Block 10 秒（免費版只得 1 條、只有 10 秒選項）。實測：120 次並發 → 超過部分回 429；同時 Stripe webhook 75 次全部到 worker（400 簽名錯），冇被擋。新規則約 1–2 分鐘先全面生效。⚠️ 唔好開 Bot Fight Mode（會擋 Stripe webhook）。wrangler OAuth 冇 WAF 權限，改規則要喺 dashboard。
- **Stripe webhook 網址（2026-10-27 改）**：Stripe Workbench → Webhooks → WS-Techs（`we_1U8qwSHaNxLrRvtWU6mMNnQ6`，監聽 6 個 event）由 `https://propwatch-worker.johnwong777.workers.dev/api/stripe-webhook` 改做 `https://api.ws-techs.com/api/stripe-webhook`；signing secret 冇換（worker 唔使改）。改完 curl 確認新網址到 worker（400 簽名錯＝正常）。
  - ⏳ **TODO**：等第一個真實付款 event 經新網址成功（Stripe 嗰行 Failed 0、有 delivery 記錄）之後，喺 worker 嘅 workers.dev 封鎖入面拎走 `/api/stripe-webhook` 例外，`workers.dev` 只留 `/api/unsubscribe`。之前唔好拎走（網址有錯都仲有後路）。

## 效能記錄（perf_log，2026-10-28）
- 用戶想知「邊啲功能食得多資源」。`newMeter`／`meteredDb`：每個 HTTP request（`GET /api/estates/:id/listings` 呢類路由名，數字 id → `:id`）同每個 cron（`cron:drip`／`cron:daily-email`／`cron:weekly`）包住 env.DB，記 D1 查詢數、rows_read／rows_written、D1 耗時；HTTP 加回傳 bytes、總耗時、5xx。按「HKT 小時 × 路由」累積，HTTP 每 5 分鐘／300 次、cron 每次完 flush 去 `perf_log`。
- **只喺 `settings.perf_log_until`（YYYY-MM-DD）當日或之前先記**；冇呢個 key＝完全唔記（唔包 env、唔量 bytes）。開：`INSERT OR REPLACE INTO settings (key,value) VALUES ('perf_log_until','2026-10-29')`；關：刪咗佢（60 秒內生效）。
- 讀：`GET /api/admin/perf?day=YYYY-MM-DD`（按 rows_read 排），或者直接 query `perf_log`。
- 記錄期間 `first()` 經 `all()` 實現（D1 first() 冇 meta）；本機 10 個端點開／關記錄回應 byte-identical。
- 第一次本機睇到：成交記錄每次讀 ~1.5 萬行、睇樓日記 ~1.4 萬行、屋苑列表 ~4.6 千行、朋友屋企 ~3.5 千行（本機數據）。
- **靜態資源 cache-bust（2026-10-28）**：`build-frontend.mjs` build 完會將 HTML 入面 `<script src>`／`<link href>` 指去本站 .js／.css 嘅網址加 `?h=<內容 sha1 前 8 位>`（180 個連結；只改標籤屬性，唔掂 JS 字串）。內容一變 hash 就變 → 用戶即刻拎新版，唔使再等 Pages 嘅 4 小時 cache（以前改 mortgage.js 要等 4 小時先見到）。`public-search.js/.css` 喺 app.html 動態載入嘅 `?v=PS_VER` 仍然用舊方法，改嗰兩個檔要 bump `PS_VER`（search.html 嗰度已經自動 hash）。

## D1 寫入爆額調查（2026-10-29，UTC 10/28 寫入 112k／上限 100k）

- 來源：`perf_log`（HKT 小時）。基線 drip 每小時 ~64 行寫入，只有三個尖峰：
  1. **每日 06:00 HKT 全量同步**：10/28 24k → 10/29 **49k**（約 2,676 盤 × ~18 行/盤）。
     每盤每日寫：`listings`（1 + 5 index）、`listing_price_history`（1 + 3 index + trigger 更新 `listing_price_seen`）、`listing_span`（~4）。
     **隨追蹤屋苑數線性增長**，單靠呢條已經食咗半個免費額度 —— 長遠要 Workers Paid（$5/月）或者減少寫入。
  2. **新增屋苑**（22:00 HKT）：`POST /api/track` 單次 ~1 萬行寫入＋之後 drip 補齊 ~3.9 萬行。
  3. 其餘（daily-email 掃描、週報）寫入可忽略。
- 已修：`/api/track` 即場 `saveSearchResults` 之後補寫 `sync_log`（centanet/listings），drip 同日唔再重做同一單元。
- 已做：`DROP INDEX idx_lph_ref`（`listing_price_history(ref_no, snapshot_date DESC)`，被 `UNIQUE(ref_no, snapshot_date)` 完全覆蓋、code 冇建冇引用；每盤每日慳 1 行）。
  回滾：`CREATE INDEX idx_lph_ref ON listing_price_history(ref_no, snapshot_date DESC)`。
- 未做（要決定）：Workers Paid；或者「價錢冇變就唔寫 lph／listings」嘅結構性減寫（要改 saveXListings ＋ 所有讀 snapshot 嘅 query，風險高）。

### drip 寫入拆解（2026-10-29，Miniflare 實測每句 SQL 嘅 rows_written）

| 動作 | 寫入行數 |
|---|---|
| `listings` 新一日 1 行（4 個 index＋UNIQUE＋AUTOINCREMENT 序號） | 7 |
| `listing_price_history` 新一日（UNIQUE＋idx_lph_estate_ref＋序號＋trigger 更新 listing_price_seen） | 5 |
| `listing_span` bump last_seen | 2 |
| **每盤每日合計** | **14** |
| `INSERT OR IGNORE` 撞咗（乜都冇寫） | **照計 1**（AUTOINCREMENT） |
| 成交新 insert | 6 |
| settings upsert | 1–2 |
| 恒生估值 REPLACE 同價 4 ＋ history 3 | 7／單位 |

- 10/29 06:00：9 個屋苑、2,676 盤 × 14 ≈ 37.5k；其餘 ~12k = 成交成段歷史每日再 INSERT OR IGNORE（每宗 1 行）＋
  冇座數「影子」成交每日 insert 完又被 `dropShadowTxns` 刪＋恒生自動估值（238 單位 × 7）＋ heartbeat。
- 已修：`newTxnsOnly()`（成交／租務成交入庫前先讀返已有 id／combo／影子，淨係 insert 新嘅；型別唔肯定就交返 DB 判斷），
  `cron_last_drip` heartbeat 由每 2 分鐘改每 5 分鐘寫一次。測試：`tests/txnfilter.test.js`（同 INSERT OR IGNORE 結果對照）。
- 未做嘅大項：`listing_price_history` 改為「價錢有變先寫」（每盤每日慳 5 行 ≈ 36%），要逐個 audit ~20 個讀 lph 嘅 query
  （好多靠「每日一行」，例如 `listing_price_seen.last_date`、`MAX(snapshot_date)`）；AUTOINCREMENT 拎走要重建 15 萬行表，免費額度做唔到。
- 恒生估值（2026-10-29）：估值冇變就 `UPDATE fetched_at`（1 行）代替 `INSERT OR REPLACE`（4 行）；history 照舊每日一筆（圖唔變）。
- 「搬日期」唔慳：`UPDATE listing_price_history SET snapshot_date` 實測 5 行（同 insert 一樣，因為 snapshot_date 喺 UNIQUE＋index＋trigger）；
  `hangseng_valuation_history` 改 fetched_at 都要 2 行（idx_hsvh_lookup 包咗 fetched_at）。
  要慳就要加**冇 index 嘅欄**（例如 lph.seen_until）去 update：1 行；冇變價時 `INSERT … WHERE NOT EXISTS` 唔插：0 行。

### listing_price_history 稀疏化（2026-10-29，`seen_until`）

- **寫法**：`lphStmts()`＝兩句 batch：① 最後一行同價 → `UPDATE … SET seen_until = 今日`；② 唔同價／未有記錄 → insert 新一行（`snapshot_date`＝改價日）。
  實測（Miniflare）：價錢冇變 **5 → 2 行寫入**（update 1＋`trg_lph_seen_until` 同步 `listing_price_seen` 1）；同日 retry 0；新盤／改價照舊 5。讀取每盤 +~5 行。
- **舊數據唔郁**：之前嘅每日一行照留（`seen_until` NULL）。讀嗰邊一律用 `COALESCE(seen_until, snapshot_date)` 做「呢行最後一日」，新舊混埋都啱。
- **讀取改咗嘅位**：原價（`/api/estates/:id/listings` 嘅 prev，用 `lphRowAtSql`＝覆蓋 D 嗰段，否則 D 之後第一行）、歷史動態改價（first_h/last_h）、
  歷史動態睇過嘅盤改價、睇樓記錄對應盤 `price_bounds.last_d`、售價歷史 API 同 `attachPriceHistorySegments`（`expandPriceRuns` 還原段頭段尾，前端唔使改）。
  冇改（結果本身一樣）：今日改價／新盤（`MAX/MIN snapshot_date`）、改價統計 cuts、進階搜尋、收藏改價點（LAG）、`listing_price_seen` 改價次數。
- **驗證**：正式 lph 147,927 行逐日重播新寫入 SQL（連 trigger）→ 稀疏版 13,301 行（9%）；11,757 個 ref × 55 個日子（64.7 萬組合）對照舊語意：
  價錢、改價次序、改價次數、D 日價、今日改價舊價、收藏改價點 **0 差異**。唯一分別（預期）：一個盤喺 D 前後都以同價見到但中間有日子冇見到
  （屋苑輪流 sync／scrape 甩），第一段開始日顯示 D 而唔係「D 之後第一次見到」（67,287 組合，約 10%）。script：scratchpad `lphv/verify.mjs`。
  單元測試：`tests/lph-sparse.test.js`。正式 D1 `EXPLAIN` 過新寫入 SQL 同 5 條改過嘅 API query（冇 lph 全表 SCAN）。
- **Migration**（已喺正式 D1 行咗）：`ALTER TABLE listing_price_history ADD COLUMN seen_until TEXT`＋重建 `trg_lph_seen_upd/_del`（用 COALESCE）＋新 `trg_lph_seen_until`；
  settings `lph_seen_until_v1=1`。新環境由 `ensurePriceSeen()` 自動做。
- **回滾**：revert code 即可（舊 code 照每日 insert，新 trigger 對舊寫法兼容）；之後嘅稀疏行舊 code 讀會當「只見過開始嗰日」，要對返就跑一次
  展開 script（按 seen_until 補返每日行）——一般唔需要。

### 新屋苑每日名額（2026-10-29，`sec_onboard_per_day`）

- **問題**：從未 sync 過嘅新屋苑第一次抓齊要寫 ~40k 行 D1（`/api/track` 即場 ~10k＋drip 補齊 ~31k），免費版每日上限 10 萬、普通日已 ~48k，同日加兩個就爆。
- **做法**：每個 **UTC 日**（＝D1 額度日，香港 08:00 重置）只放行 `sec_onboard_per_day`（預設 1，admin 設定頁「新屋苑：每日最多完整 sync 幾個」可調）個「從未 sync 成功過」（`sync_log` 冇 `kind='listings' AND ok=1`）嘅屋苑做完整 sync。
  - 放行狀態：`settings.onboard_slots = {day, ids:[{id, hk}]}`（`hk`＝放行嗰日嘅香港日，同日一直入計劃，過咗香港午夜唔重做）。
  - `/api/track`：新屋苑 `claimOnboardSlot`；有位照舊即場抓 centanet；冇位只加入清單，回 `{queued:true}`，前端 toast「明早 8 點後陸續更新」。admin 加屋苑 `force`（唔受限但照計數）。
  - drip：`buildPendingUnits` 帶 `never_synced`；`getDailySyncEstateIds` 將從未 sync 嘅屋苑（連最愛）排出日常計劃，名額有空就按 id 先後補位（額度日一轉後 ≤30 分鐘，受 `sync_idle_until` 影響）。放行時順手幫收費訂閱者排恒生插隊掃描（`hsQueueIfPaidSubscribed`，原本喺 track 即場做，排隊嗰陣冇數據查嚟冇用）。
  - Telegram：新屋苑第一個訂閱者令排隊 ≥5 個時通知（`onboardQueue`）：「考慮升 Workers Paid，再調高名額」。
- 順手：`/api/track` 舊屋苑今日已被 drip 做過 centanet 放盤就唔再抓再寫（以前平白 ~1 萬行）。
- 名額係軟上限（兩個 request 同時搶位可能多放一個）。測試：`tests/onboard.test.js`。
- 副作用：排隊中嘅屋苑，用戶見到「暫無放盤資料」直到補位；`/api/estates/:id/*` 照常可讀。

### 主頁輪播：待跟進 ＋ 搵樓搜尋（2026-10-29）

- 主頁 `#viewing-todo` 位置改為輪播（`renderHomeCarousel`／`hcLayout`／`hcGo`／`hcFit`）：有待跟進就「待跟進｜🔍 搵樓：四大地產網一次過搜尋」兩張卡（點點、撳點點、手指橫掃；預設見待跟進）；冇待跟進就淨係見搜尋表單，冇點點。
- 搜尋卡係 `PublicSearch.mount(el, {formOnly:true, onSearch})`：只畫表單（預填睇樓偏好），撳搜尋 → `openPublicSearch(qs)` 跳去搵樓頁（`opts.initialQs` 帶條件、即刻搜、記入最近搜尋）。
  地區／房數／售價／面積／地產網默認收埋喺「更多條件 ▾」（有條件會標「已設 N 項」，例如偏好預填），主頁唔會太高。
- 結構只建一次，`renderViewingTodo` 只更新 `#hc-todo`（用戶打緊嘅搜尋條件唔會被洗走）；高度用 ResizeObserver 跟住當前卡。
- 改 `public-search.js/.css` 要 bump `app.html` 嘅 `PS_VER` 同 `search.html` 兩個 `?v=`（現 `20261030a`）。

### 搜尋結果「N 人心儀」（2026-10-30）

- app 入面搵樓搜尋結果卡：中原等標籤旁顯示「❤️ N 人心儀」（該盤 URL 有幾多個用戶 ♥ 咗）。公開 `/search` 頁唔顯示（要登入先有 `opts.fav`）。
- 後端 `POST /api/favourite-listings/external-counts`（要登入，body `{deal, urls[≤60]}`）：只回彙總人數 `{counts:{url:n}}`，達 `sec_heat_min_users`（預設 5，admin 設定頁可調，最低 3）先出；
  唔計 `role='system'`／停用帳戶；少過門檻嘅 URL 唔出現，前端分唔出「冇人」同「少過門檻」。按 `listing_favourites(estate_id=0, ref_no=URL)` 查，新 index `idx_favl_ref(ref_no, deal)`（SCHEMA_VERSION → 2026-10-30a）。
- 前端：`public-search.js` 每次 `renderAll` 後批量問未問過嘅 URL（`countAsked` 去重），結果 `paintLike` 補落已畫嘅卡；撳 ♥ 後重問該 URL（自己一票可能令人數過／跌穿門檻）。
- 只計「搜尋結果收藏」（外部 URL）；屋苑頁自己 DB 放盤嘅收藏人數照舊走 `/api/estates/:id/crowd`。同一個單位喺不同網站有各自 URL，人數各計各。
- 測試：本機 worker 種 6 個帳戶＋1 個系統帳戶驗證（門檻、買租分開、壞輸入、>60 URL、401）。
