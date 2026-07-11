# PropWatch — Claude Code 項目規則

## 安全 Convention（強制 — 所有新功能一律跟從）

呢個系統嘅數據係經年累月 scrape 返嚟嘅資產。以下規矩係為咗防止:
XSS/HTML injection、API 被人狂抽數據去做類似嘅系統。**每個新 feature 都要跟。**

### Worker（後端）

1. **新 endpoint 一律放喺 auth guard 後面**（`const session = await authenticate(...)` 之後）。
   唯一例外係 `/api/login`、`/api/logout`、`/api/register` — 唔准再加新嘅公開 route。
   如果某功能「好似」要公開（例如 debug、email trigger），都要行 auth：
   之前 `/api/send-today-email` 同 `/api/debug-ricacorp-pages` 公開過，係漏洞，已搬入 guard 內。
2. **CORS 係 allow-list**（`isAllowedOrigin()` / `applyCors()`，喺 fetch 出口統一 reflect）。
   加新 origin 前要諗清楚；唔准改返做 `*`。
3. **安全數字參數用全局 `sec_*` settings key + code default**（`SEC_DEFAULTS`）。
   唔准擺入 per-account 嘅 `CONFIG_DEFS` ⚙️ 設定 — 否則攻擊者可以自己較大自己個上限。
   （一般分析參數就照舊入 CONFIG_DEFS。）
4. **所有查詢要 scope 返 per-account**：estates 經 `account_estates ae WHERE ae.account_id = ?`，
   viewings/system_parameters 經 `account_id = ?`，config key 用 `cfg_<accountId>_<key>`。
   唔准寫漏 scope — 會跨帳戶漏數據。
5. 錯誤訊息唔好漏內部細節（login 失敗永遠回同一句 `用戶名或密碼錯誤`）。

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
