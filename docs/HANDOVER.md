# 搵樓日記交接文件

寫俾**接手嘅人或者 AI**。目的係：唔使揭 452 個 commit 或者幾百 K 字對話，
睇完呢份就知個系統做緊咩、邊啲決定係「特登咁做」、同埋踩過邊啲坑。

最後更新：2026-08-23（commit `10c43e1`）

---

## 0. 落手之前

1. **先讀 `../CLAUDE.md`** —— 入面係強制嘅安全 convention（XSS escape、
   auth guard、per-account scoping）。唔係建議，係每個新 feature 都要跟。
2. **再讀 `NOTES.md`** —— 架構同技術細節。
3. **踩過嘅坑喺 `NOTES-ARCHIVE.md`** —— 睇完可以慳返好多重複踩。
4. 用戶用**繁體中文（廣東話語氣）**溝通。code／commit message／技術名詞
   照用英文。

## 1. 個系統做緊咩

每日自動抓香港四個地產網嘅放盤／租盤／成交 → 儲落 Cloudflare D1 →
計「呢個盤相對同苑近期成交平定貴」→ 每朝 09:00 email 一份今日動態。

真正資產係**經年累月 scrape 返嚟嘅歷史數據**（邊個盤幾時上架、改過幾多次價、
幾時下架、真實成交幾錢）。呢個係收費分界線嘅基礎：
- **免費**：今日 snapshot（而家有咩盤、幾錢）——任何 portal 都睇到嘅嘢
- **收費**：時間軸（放盤日數／改價／下架／趨勢）＋ 主動推送（email／alert）

## 2. 技術骨架

| 層 | 用咩 | 喺邊 |
|---|---|---|
| 前端 | 單一 `index.html`（冇 framework、冇 build step） | `frontend/` |
| 後端 | Cloudflare Worker，單一 `index.js`（~7,900 行） | `worker/` |
| DB | Cloudflare D1（SQLite） | binding `DB` = `propwatch-db` |
| 排程 | 2 個 cron trigger | 見下 |
| 付款 | Stripe（Checkout + billing portal + webhook） | secrets 喺 Cloudflare |

**冇 build step、冇 bundler。** 前端就係一個 HTML 檔，改完直接 deploy。
呢個係特登嘅——省返成套 toolchain，改嘢即刻見到。

### 兩個 cron（Free plan 上限 5 個 expression，用咗 2 個，要留位）

- `*/2 * * * *` — drip sync。每 2 分鐘做「一批單元」，一個單元 =
  屋苑 × source × 種類（放盤／成交／租盤／租務成交）。
- `0 1 * * *`（= 09:00 HKT）— 每日 email。**同時搭順風車做 Stripe 對數**
  （見 §4）。

## 3. 四個 source（`SOURCES` registry）

加／減 source 只需要改 `worker/index.js` 個 `SOURCES` array 同前端一個對應
array——sync、per-estate toggle、filter chips、badge、schema 欄位全部自動跟。

| id | 名 | 有咩能力 |
|---|---|---|
| `centanet` | 中原 | 放盤 + 成交 + 估值（唯一有估值）|
| `ricacorp` | 利嘉閣 | 放盤 + 土地註冊成交 |
| `hkp` | 香港置業 | 放盤 + 成交 + 租盤 |
| `midland` | 美聯 | 放盤 + 租盤（**特登冇成交**，見下）|

⚠️ **美聯同香港置業係同一間公司、同一個後台**，API 連欄位名都一樣（所以
共用 parser，只係 HKP 行 `search/v1`、美聯行 `search/v2`）。實測：
- **成交完全一樣**，連 transaction id 都相同 → 只可以有一個做 master，
  揀咗香港置業（已有 1,622 宗標 `hkp`，而 combo UNIQUE 索引先入為主，
  轉 master 都改唔到舊嗰批，個表會變一半一半更亂）
- **放盤零重疊** → 呢度先係美聯嘅價值（一日 271 個買盤）

## 4. 收費／降級（近期改得最多，最易搞錯）

`accounts.tier`（free/paid）係**唯一真相**，全部 gate 行 `isPaidSession()`，
回 **402**（唔好靠前端收埋個掣——free user 照 call 到 API）。

### 降級唔會刪嘢

超出免費上限嘅屋苑訂閱標記做 `account_estates.paused_at`（保留最愛嗰幾個），
升級返一次過解除。暫停咗嘅唔 sync、唔計入上限、側邊欄淡色顯示 +「恢復」掣。

⚠️ **改 tier 有 5 條路徑，全部要 call `applyTierEstateLimit()`**：
`applySubscription`、`subscription.deleted`、`checkout.session.completed`
冇-subscription 分支、`authenticate()` 人手開通到期、admin `/api/admin/tiers`。
漏咗任何一條 = 靜靜超額。

⚠️ estates 跨帳戶共用、sync 係 per-estate，所以**淨係當冇任何其他帳戶仲
生效訂緊，暫停先真係慳到 sync**。

### 續期唔使我哋做嘢

Stripe subscription 自動循環扣數。**冇任何 code 主動去 Stripe 收錢**，我哋
淨係聽 webhook 更新 DB。

### 對數（因為 webhook 會漏）

所有降級都靠 webhook，一漏個帳戶就永遠停喺 paid。所以每日喺 email cron 度
行一次 `reconcileSubscriptions()`。慳 subrequest 嘅關鍵：用
`GET /v1/subscriptions?status=all&limit=100` **一次過**攞晒再喺 JS match，
唔係逐個帳戶 call。順序一定係**先對數、後寄信**。
`past_due`/`unpaid`/`incomplete` 嗰批會 skip 埋當日 email。
手動版：`POST /api/admin/billing/reconcile`。

## 5. 幾個「唔好改返轉頭」嘅決定

- **`past_due` 照畀用**（`PAID_SUB_STATUSES` 包住佢）。Stripe 仲喺度重試，
  即刻趕人走只會激嬲一個張卡啱啱到期嘅好客。
- **`.listings-section` 唔落 `backdrop-filter`**。會 scroll 嘅表格落 blur
  要逐格重繪；reference 站自己個 `.data-table` 都係 `none`。
- **`background-attachment: fixed` 唔可以同 `backdrop-filter` 一齊用** ——
  實測 scroll 完上半版永久變死黑。用 `position: fixed` 嘅 `body::before`。
- **D1 閃斷唔即刻 alert**，但唔可以靜音：重試 3 次 → 連續 3 次 cron 都掛先
  出 🚨 → 就算唔 alert 都會喺每日 summary 報返次數。`isTransientD1()` 特登
  收得好窄，真 SQL 錯要即刻拋，唔可以俾重試埋咗。
- **同步時間報「實際做嘢」唔報首尾跨度**。跨度會俾 06:00 時窗同 cron 停頓
  發大（實測報過「3 小時」但真正做嘢 30 分鐘）。

## 6. 按揭計算機（自成一角，數字全部有官方出處）

`frontend/index.html` 入面嘅 pure function，client-side 計。三張官方表：

| 表 | 出處 | 生效 |
|---|---|---|
| `AVD_BANDS` 印花稅 | 稅務局 | 2026-02-26 起（>$1億 加到 6.5%）|
| `MIP_LTV` 按揭成數上限 | 按證保險 | 現行 |
| `MIP_PREMIUM` 按保費率 | 按證保險「按揭保費一覽表」 | 2024 年 10 月版 |

要記住嘅：
- SSD／BSD／NRSD 已經 2024-02-28 全部撤銷；壓力測試 2025-02-28 取消
- **90% 成數先係首置專屬**；80% 呢層首置同非首置一樣，一路到 $1,715萬
- 按保**淨係批自住**，收租盤封死喺金管局 70%
- 花紅計法（兩年平均 ÷ 12、封頂底薪 3 倍）同「出租封 7 成」係**市場慣例，
  唔係監管規定**，UI 有寫明

⚠️ 倒推「買得起幾錢樓」**唔可以當一律借盡九成**——現金多過首期嘅人會被
算細成 4 成。要「用晒現金，爭幾多借幾多」。而且按保費率係**階梯函數**，
迭代逼近唔會收斂（實測 89.99% ⇄ 91.94% 跳足六轉），要逐個可能費率解方程
再驗返落唔落返嗰個檔。

## 7. Deploy

```bash
cd worker && npx wrangler deploy
```

```bash
TMPDIR=/tmp npx wrangler pages deploy frontend --project-name=propwatch --branch=main --commit-dirty=true
```

前端嗰句要**喺 project root** 行（唔係 `frontend/` 入面）。
Pages 有 CDN cache，deploy 完即刻開可能仲係舊版——用
`fetch(location.href,{cache:'reload'})` 或者加 query string 迫佢攞新。

## 8. 驗證嘅標準（用戶好睇重）

呢個 project 嘅習慣係**唔靠讀 code 就話「應該冇問題」**：
- 新 endpoint：冇 token call 一下要 401
- 新 render 位：擺 `<img src=x onerror=alert(1)>` 落去，睇佢 render 做文字
- 跨帳戶：開臨時帳戶確認睇唔到人哋數據，**測完清走**
- 改咗計算邏輯：抽個 pure function 出嚟真係跑一次對官方數字
- 改咗 UI：真係開 browser 截圖睇

用戶會 push back 唔準確嘅陳述。與其講「應該得」，不如量咗先講。
