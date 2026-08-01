# PropWatch — Claude Code 項目規則

## 安全 Convention（強制 — 所有新功能一律跟從）

呢個系統嘅數據係經年累月 scrape 返嚟嘅資產。以下規矩係為咗防止:
XSS/HTML injection、API 被人狂抽數據去做類似嘅系統。**每個新 feature 都要跟。**

### Worker（後端）

1. **新 endpoint 一律放喺 auth guard 後面**（`const session = await authenticate(...)` 之後）。
   唯一例外係 `/api/login`、`/api/logout`、`/api/register`、`/api/stripe-webhook`
   — 唔准再加新嘅公開 route。
   如果某功能「好似」要公開（例如 debug、email trigger），都要行 auth：
   之前 `/api/send-today-email` 同 `/api/debug-ricacorp-pages` 公開過，係漏洞，已搬入 guard 內。

   `/api/stripe-webhook` 冇得行 auth（Stripe server 打嚟，冇我哋嘅 token），
   所以佢**改為靠 HMAC 簽名驗證**（`stripeVerifySignature`，Stripe 官方演算法 +
   300 秒 replay window）。加呢類 endpoint 嘅硬規矩：
   - 一定要驗簽，驗唔過即刻 400，唔准「驗唔到就當佢真」；
   - 一定要用 **raw body** 驗（parse 完再 stringify 會爆簽名）；
   - 只准寫狀態，**唔准回任何數據**俾 caller（唔可以變成免 auth 嘅讀取窗口）；
   - 要 idempotent（`payment_events.stripe_event_id` UNIQUE），因為 Stripe 會重試。
2. **CORS 係 allow-list**（`isAllowedOrigin()` / `applyCors()`，喺 fetch 出口統一 reflect）。
   加新 origin 前要諗清楚；唔准改返做 `*`。
3. **安全數字參數用全局 `sec_*` settings key + code default**（`SEC_DEFAULTS`）。
   唔准擺入 per-account 嘅 `CONFIG_DEFS` ⚙️ 設定 — 否則攻擊者可以自己較大自己個上限。
   （一般分析參數就照舊入 CONFIG_DEFS。）
4. **所有查詢要 scope 返 per-account**：estates 經 `account_estates ae WHERE ae.account_id = ?`，
   viewings/system_parameters 經 `account_id = ?`，config key 用 `cfg_<accountId>_<key>`。
   唔准寫漏 scope — 會跨帳戶漏數據。
5. 錯誤訊息唔好漏內部細節（login 失敗永遠回同一句 `用戶名或密碼錯誤`）。
6. **收費／付款**：`tier`（free/paid）係「有冇得用收費功能」嘅唯一真相，
   全部 gate 行 `isPaidSession()` + 回 **402**（唔好靠前端收埋個掣 —— free user
   照 call 到 API）。免費上限數字入 `sec_*`，唔准入 CONFIG_DEFS。
   Stripe key 一律 `wrangler secret put`（`STRIPE_SECRET_KEY` /
   `STRIPE_WEBHOOK_SECRET`），**唔准寫入 code 或者 git**。
   ⚠️ 個 Stripe 帳戶同 iPointWeb 共用 —— 帳戶層設定（例如 Adaptive Pricing）
   郁咗會連 iPoint 個 shop 一齊影響，改之前要諗清楚。

### Frontend（`frontend/index.html`）

所有動態內容入 HTML 前必須 escape，用檔案底部嘅 helpers：

| 位置 | 用邊個 helper |
|---|---|
| HTML 文字/屬性 | `escHtml(x)` |
| `href="…"` | `safeUrl(x)` — escHtml 擋唔到 `javascript:` URL |
| `<img src="…">` | `safeImgSrc(x)` — 只准 http(s)/`data:image` |
| inline `onclick="fn('…')"` 字串參數 | `escJsAttr(x)` — escHtml 唔會 escape 單引號 |

「動態內容」包括：用戶輸入（notes/block/floor/unit…）**同埋** scrape 返嚟嘅字串
（estate name/building_name/detail_url/agent…）— scrape source 都當唔可信。

### Pages headers（`frontend/_headers`）

CSP 已鎖 `connect-src`（只准 call 自己 worker）同 `img-src`（self + data:）—
就算俾人注入咗 script 都運唔到數據出第三方。加新外部資源（CDN/font/API）前
要諗清楚係咪真係需要，需要就精準加落 CSP，唔准放寬做通配。

### 改完點 verify

新 endpoint：冇 token call 一下要 401。新 render 位：入個 `<img src=x onerror=alert(1)>`
做測試數據，睇佢 render 做文字。跨帳戶：開個臨時帳戶確認睇唔到人哋數據，測完清走。

## 其他

- 技術細節/架構睇 `NOTES.md`；舊坑睇 `NOTES-ARCHIVE.md`。
- Deploy：worker 喺 `worker/` 行 `npx wrangler deploy`；
  frontend 喺 root 行 `TMPDIR=/tmp npx wrangler pages deploy frontend --project-name=propwatch --branch=main --commit-dirty=true`。
