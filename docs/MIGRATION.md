# 搬機指南 + 2026-08-26/27 工作總結

寫於 2026-09-23。目的：換 MacBook 之後，接得返手，唔會漏嘢。

⚠️ 2026-09-24：正式域名由 `homefinding.ws-techs.com` 改咗做
`home.ws-techs.com`（舊域名冇再用，DNS record 已刪）。下面內容係
8/26–27 嗰陣寫嘅，講嘅域名已經過時，睇嗰陣心中轉一轉個名就得。

---

## 0. 先講你問嘅嗰條：點解新 Mac 見唔到同一個對話

**Claude Code 嘅對話記錄係純本地檔案，唔會 sync 上雲。**

存放位置：

```
~/.claude/projects/<工作目錄路徑轉碼>/xxxxx.jsonl
```

個 folder 名係由**工作目錄嘅絕對路徑**逐個 `/` 轉做 `-` 砌出嚟。例如：

| 工作目錄 | 對應 folder |
|---|---|
| `/Users/seanwong/Downloads/propwatch` | `-Users-seanwong-Downloads-propwatch` |
| `/Applications/XAMPP/xamppfiles/htdocs/AI_Project/PropWatch` | `-Applications-XAMPP-xamppfiles-htdocs-AI-Project-PropWatch` |

所以喺新 Mac 見唔到，有兩個原因疊埋一齊：

1. 啲 `.jsonl` 根本冇 copy 過去；
2. 就算 copy 咗，**新機嘅路徑要一模一樣**（連 username `seanwong` 都要一樣），
   否則 Claude Code 會當佢係另一個 project，`--resume` 揀唔到。

> ⚠️ 依家呢個對話嘅記錄係收喺 `-Users-seanwong-Downloads-propwatch`（211MB、3 個對話），
> **唔係** XAMPP 嗰個 folder —— 因為開 session 嗰陣個 cwd 係 Downloads 嗰個舊 copy。

---

## 1. ⚠️ 搬機之前，兩個一定要先處理嘅風險

### 風險 A：136 個 commit 淨係存在於呢部機

```
main...origin/main [ahead 136]
```

由 `10c43e1` 之後嘅**全部**嘢都未 push 上 GitHub，包括：

- 改名做「搵樓日記」
- Production／Test 環境分家、自訂域名 `homefinding.ws-techs.com`
- Stripe 由 test key 轉 live key
- 卡片 view、相片 proxy、filter 收埋、sticky 修正……

**即係話：如果而家部機爆咗，或者你喺新機 `git clone`，呢 136 個 commit 全部冇咗。**
呢個唔止係搬機問題，係日常備份漏洞。**搬機第一步就係 push。**

### 風險 B：同一個 project 有兩份 copy，而且唔同步

| 路徑 | commit | 狀態 |
|---|---|---|
| `/Applications/XAMPP/xamppfiles/htdocs/AI_Project/PropWatch` | `d0b4f6a` | ✅ **真正喺用嗰個**（409M） |
| `/Users/seanwong/Downloads/propwatch` | `10c43e1` | ❌ 舊 copy，落後 136 個 commit（270M） |

兩個都指住同一個 GitHub remote。舊嗰個係搬 folder 之前遺留低（見
`memory/project_propwatch_paths.md`）。

**搬機只需要搬 XAMPP 嗰個。** Downloads 嗰個建議搬完機之後喺舊機刪咗，
費事將來又搞錯邊個先係真。

---

## 2. 建議做法（比起「成個 folder copy 過去」好）

你原本諗住整個 folder 搬。可以，但有幾個問題：`node_modules` 176M、
`backups/` 128M、對話記錄 211M，夾埋成 500M+，而且 `node_modules` 喺新機
本來就要重裝先穩陣。

**建議改成「git 為主 + 手動補返 git 冇嘅嘢」：**

### Step 1 — 喺舊機（依家部）先 push

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/AI_Project/PropWatch
git add -A && git commit -m "搬機前：commit 低所有改動"
git push origin main
```

> 注意：依家仲有 1 個未 commit 嘅改動（`worker/index.js` —— forgot-otp
> 加 log 嗰個修正）。上面條 `git add -A` 會順手 commit 埋。

### Step 2 — 喺舊機打包「git 冇嘅嘢」

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/AI_Project/PropWatch
tar -czf ~/Desktop/propwatch-extras.tgz memory .claude backups
```

三樣嘢分別係：

| 項目 | 係咩 | 要唔要 |
|---|---|---|
| `memory/` | Claude Code 記住你嘅偏好同 project 筆記（32K） | **一定要** |
| `.claude/` | project 層設定，含 `settings.local.json`（60K） | 要 |
| `backups/` | git 之前嗰段時間嘅 zip 備份（128M） | 可選，純保險 |

### Step 3 — 喺新機還原

```bash
# 路徑要一模一樣，否則 memory 同對話記錄對唔返
mkdir -p /Applications/XAMPP/xamppfiles/htdocs/AI_Project
cd /Applications/XAMPP/xamppfiles/htdocs/AI_Project
git clone git@ssh.github.com:seanwong65/PropWatch.git PropWatch
cd PropWatch
tar -xzf ~/Desktop/propwatch-extras.tgz
npm install --prefix worker    # 重裝 node_modules，唔好由舊機 copy
```

### Step 4 — 重新認證（呢啲唔可以 copy，亦唔應該 copy）

```bash
# Cloudflare（deploy worker / Pages / D1 全部要）
npx wrangler login

# GitHub SSH key：喺舊機 copy ~/.ssh/id_ed25519 同 .pub 過去，chmod 600
```

### Step 5 — 對話記錄（想 `--resume` 返舊對話先需要）

```bash
# 喺舊機
tar -czf ~/Desktop/claude-convos.tgz \
  -C ~/.claude/projects -- -Users-seanwong-Downloads-propwatch

# 喺新機
mkdir -p ~/.claude/projects
tar -xzf ~/Desktop/claude-convos.tgz -C ~/.claude/projects
```

再加埋全機設定：`~/.claude/settings.json`（權限 allow-list + auto mode）。

> **坦白講一句**：呢 211MB 對話嘅實際價值有限 —— `--resume` 返去一個幾百 K
> 字嘅舊對話，Claude 一樣要重新讀晒先做到嘢，而且會食大量 context。
> **更好嘅做法係靠文件接手**：`docs/HANDOVER.md` + `CLAUDE.md` + `memory/`，
> 呢三份先係真正「搬得走嘅記憶」。對話記錄當備份 copy 過去就算，唔使當寶。

### Step 6 — 驗證

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/AI_Project/PropWatch
git log --oneline -1          # 應該見到最新嗰個 commit
ls memory/                     # 應該有 8 個檔
npx wrangler whoami            # 確認 Cloudflare 接得返
```

---

## 3. ⚠️ 唔喺本機、亦都唔使搬嘅嘢

呢啲全部存喺 Cloudflare，換機唔會影響，**但亦都代表本機備份救唔返佢哋**：

| 嘢 | 喺邊 |
|---|---|
| D1 數據庫 `propwatch-db`（production 真實數據） | Cloudflare |
| D1 數據庫 `propwatch-db-test` | Cloudflare |
| Stripe live key、webhook secret | Cloudflare Worker secret |
| Gmail refresh token、Telegram bot token | Cloudflare Worker secret |
| 域名 `ws-techs.com` + DNS | Cloudflare |

`wrangler secret list` 睇到名，但**睇唔返個值**。如果 secret 掉咗，要去返
Stripe／Google／Telegram 重新攞過。

---

## 4. 系統現況（搬完機要知嘅嘢）

### 兩套環境

| | Production | Test |
|---|---|---|
| 前端 | `homefinding.ws-techs.com` | `propwatch.pages.dev` |
| Worker | `propwatch-worker` | `propwatch-worker-test` |
| D1 | `propwatch-db` | `propwatch-db-test`（production 嘅 snapshot copy） |
| Stripe | live key | **冇任何 secret** |
| Email | 正常寄 | **完全寄唔到**（雙重保險：`IS_TEST_ENV=1` 短路 + 冇 Gmail secret） |

前端係同一份 build 服務兩個域名，靠 `location.hostname` 決定打邊個 worker。

### Deploy 指令

```bash
# Production worker
cd worker && npx wrangler deploy

# Test worker
cd worker && npx wrangler deploy -c wrangler.test.toml

# 前端（兩個域名共用）
TMPDIR=/tmp npx wrangler pages deploy frontend \
  --project-name=propwatch --branch=main --commit-dirty=true
```

### Cron

兩個 worker 各自有自己嘅 cron（實測確認 5 個 quota 係 **per-script**，唔係
account-wide）：

- `*/2 * * * *` — drip sync
- `0 1 * * *` — 09:00 HKT 每日通知 email

---

## 5. 2026-08-26／27 做咗啲乜（呢個對話嘅內容）

### 卡片 view（最新放盤 / 租盤）

- 表格 ⇄ 卡片切換，**預設卡片**，買租共用同一個偏好
- 相片來源：中原／利嘉閣由 DB `listings.thumbnail`；美聯／香港置業即時問 API
- 美聯／香港置業啲相要**經 worker proxy**（`/api/photo`）—— 佢哋個 CDN
  （`wmc.*.com.hk`）對外來 request 一律 403，瀏覽器直接 hotlink 攞唔到
- `<img>` 送唔到 Authorization header，所以前端 fetch 完轉 blob URL
- 橫向揭相：一次只載緊住嗰張同下一張（`sec_card_photos_max` 封頂）
- 利嘉閣啲相係由 sync 時已經 fetch 咗嘅 HTML 入面抽（零額外 request），
  條 URL 要保留 `?width=240&height=135`，剝走參數會由 20KB 變 1.4MB

### 踩過嘅坑（都係 CSS 連鎖反應）

1. 為咗令 sticky filter 列生效，`.listings-section` 個 `overflow` 由
   `hidden` 改做 `clip`
2. → 手機版 `position:sticky` 全部失效（`html`/`body` 個 `overflow-x:hidden`
   令佢哋變 scroll container；`.main` 個 `overflow-y:auto` 同樣問題）
3. → 改完之後成交表右邊拉唔到（`.main` 冇 `min-width:0`，CSS Grid item
   預設最小闊度 = 內容闊度，撐爆咗 grid track）
4. → 再發現 `loading="lazy"` 喺 `overflow:clip` 祖先之下**完全唔 fire**，
   所有 DB thumbnail 都載唔到。改用自己一個 IntersectionObserver

### Filter

- 四個 filter bar（買盤／租盤／買盤成交／租盤成交）統一收埋，靠一個
  「🔍 篩選」pill 掣開合，收埋時留一行摘要 chip
- Chip 可以逐個撳走；min/max 只填一邊會講人話（「800萬內」／「500萬以上」）

### 每日 email cron 靜靜唔 fire

查 Cloudflare invocation analytics 發現 08-22、08-24 兩日 01:00 UTC 得 1 個
invocation（淨係 drip），email cron 完全冇跑。而所有 alert 都係喺 email cron
**入面**發，即係「cron 唔 fire」呢個 case 永遠冇 alert。

修法：加 heartbeat（`cron_last_email_start/_done`）+ 由 drip cron 順手做
watchdog，過咗 10:00 HKT 仲未見到今日打卡就出 telegram + 即刻補跑。

### 環境分家 + 上正式域名

- `homefinding.ws-techs.com` 做 production（需要喺 Cloudflare 手動加一條
  CNAME → `propwatch.pages.dev`，Proxied）
- 開新 worker + 新 D1（由 production export/import 一份完整 copy）做 test
- D1 匯入要**schema 同 data 分開**，一齊匯會撞 FK constraint
  （wrangler batch 執行會打斷 `defer_foreign_keys` 嘅 transaction 保證），
  data 嗰份要前置 `PRAGMA foreign_keys=OFF;`

### Stripe test → live

- price／customer／subscription ID **全部係 mode-specific**
- 加咗 `stripeMode` 診斷（睇 key prefix，唔洩露 key 本身）
- 踩過嘅坑：開咗 live price 但 `effective_from` 填得早過舊嗰批 test row，
  `activePlan` 個 `ORDER BY effective_from DESC` 照舊揀 test price ——
  「開咗 live price」唔等於「個系統會用佢」
- 清走 test01 個幽靈訂閱 + 5 行 test-mode 假付款記錄

### 其他

- 改名：HouseRadar → **搵樓日記**（連 `<h1>Prop<span>Watch</span></h1>`
  被 span 斬開所以 grep 唔到嗰個都執埋）
- Email `From` 顯示名稱亂碼 —— raw UTF-8 塞落 header，要用 RFC 2047
  encoded-word（`Subject` 一直有做，`From` 漏咗）
- 趨勢圖／市場溫度搬去獨立「樓盤分析」tab，順手令佢唔再 block 住
  `Promise.all`（之前趨勢查詢慢就連放盤表都出唔到）
- Admin 帳戶唔再受 15 個屋苑上限管
- 睇樓記錄：「分析」結論獨立起底色 box（貴紅／平綠／約灰），
  「未沽出／已沽出」放大做 pill

---

## 6. 仲未做嘅嘢

- [ ] **push 嗰 136 個 commit**（最緊要）
- [ ] `docs/HANDOVER.md` 仲停留喺 `10c43e1`，未反映上面第 5 節嘅嘢
- [ ] 忘記密碼 OTP：實測 `sendEmail()` 冇 throw（即係 Gmail 收咗貨），
      但用戶話收唔到 —— 要 check junk folder 確認係咪 deliverability 問題
- [ ] Stripe live 未做過真・小額測試（唯一方法驗到 live webhook 真係打得入嚟）
- [ ] 舊 copy `/Users/seanwong/Downloads/propwatch` 未刪
