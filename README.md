# PropWatch

香港樓市追蹤系統。每日自動抓四個地產網嘅放盤／租盤／成交，儲落 Cloudflare
D1，計出「呢個盤相對同苑近期成交平定貴」，再每朝 09:00 email 一份今日動態。

**呢個 folder 係成個 project 嘅唯一位置**——換電腦淨係要搬呢一個 folder，
唔會再散落喺其他 path。

---

## 呢個 folder 有咩

| 位置 | 係咩 | 入唔入 git |
|---|---|---|
| `CLAUDE.md` | **開工前必讀**：安全規矩 + deploy 指令。Claude Code 開呢個 folder 會自動載入，所以一定要留喺 root | ✓ |
| `frontend/` | 前端（單一 `index.html`），deploy 去 Cloudflare Pages | ✓ |
| `worker/` | 後端（Cloudflare Worker + D1），`index.js` 一個檔 | ✓ |
| `docs/` | `NOTES.md`（架構／技術細節）、`NOTES-ARCHIVE.md`（踩過嘅坑）、`HANDOVER.md`（交接俾另一個 AI）、設計規格 .docx | ✓ |
| `memory/` | Claude Code 嘅記憶檔（用戶偏好、project 背景） | ✗ 跟 folder 走 |
| `backups/` | git 之前嗰段時間嘅 zip 備份 | ✗ 太大（121MB > GitHub 上限） |
| `.htaccess` | 擋 Apache 服務呢個 folder（見下） | ✓ |

## 點開工

```bash
cd worker && npm install     # node_modules 冇入 git，新機要行一次
npm test                     # 31 個 unit test
```

Deploy（兩個分開，睇 `CLAUDE.md` 尾嗰段）：

```bash
cd worker && npx wrangler deploy
```

```bash
TMPDIR=/tmp npx wrangler pages deploy frontend --project-name=propwatch --branch=main --commit-dirty=true
```

⚠️ 前端 deploy 要**喺呢個 folder 嘅 root** 行（唔係喺 `frontend/` 入面），
否則 wrangler 會搵 `frontend/frontend` 然後報 ENOENT。

## 點解有個 .htaccess

呢個 folder 坐喺 XAMPP 嘅 `htdocs`（Apache document root）之下，即係預設會經
HTTP 出得街。`.git/` 一旦 serve 得到，人哋可以 clone 走成個 repo 連完整歷史。
所以 `.htaccess` 將整個目錄 `Require all denied`（實測 `.git/config` 同
`CLAUDE.md` 都回 403）。

PropWatch **真正部署喺 Cloudflare**，同 XAMPP 完全無關——XAMPP 喺呢度純粹
係「啱好有個 folder 擺住」。

## Secrets 喺邊

**唔喺呢個 folder 入面，亦唔應該喺。** Stripe key、Telegram token、Gmail
refresh token 全部係 Cloudflare 嘅 worker secret：

```bash
cd worker && npx wrangler secret list
```

換機唔使搬——佢哋存喺 Cloudflare 嗰邊，`wrangler login` 之後就用得。
