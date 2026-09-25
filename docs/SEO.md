# 搵樓日記 SEO 記錄同計劃

寫於 2026-09-25。正式域名：`https://home.ws-techs.com/`

目標：喺 Google 搜尋排高啲。先講清楚期望——技術 SEO 只係「唔好擋住 Google」，
真正推高排名要靠**內容頁**同**外部連結**，要以月計。

---

## 1. 已經做咗（2026-09-25 上線）

| 問題 | 點改 | 檔案 |
|---|---|---|
| robots.txt 同 sitemap 仲指住舊域名 `propwatch.pages.dev`，Google 被帶去 test 版 | 改做 `home.ws-techs.com`，sitemap 加 `lastmod` | `frontend/robots.txt`、`frontend/sitemap.xml` |
| `propwatch.pages.dev` 同 preview branch 內容同正式站一樣，會爭排名（duplicate content） | `*.pages.dev` 一律回 `X-Robots-Tag: noindex` | `frontend/_headers` |
| 冇分享圖（WhatsApp／Facebook／Threads 貼連結冇大圖） | 加 `og:image`、`twitter:card = summary_large_image` | `frontend/index.html` `<head>` |
| 冇 favicon（Google 搜尋結果左邊冇 icon） | 加 `favicon.svg` + `theme-color` | `frontend/favicon.svg` |
| 成頁有兩個 `<h1>`（app header 嘅「搵樓日記」都係 h1） | header 改做 `<div class="logo-text">`，淨留 landing 標題做唯一 h1，樣式唔變 | `frontend/index.html` |

另外：舊域名 `homefinding.ws-techs.com` 已經 Cloudflare Redirect Rule **301** 去新域名
（保留 path 同 query），舊連結嘅排名權重會轉過嚟。

### 已驗證

- `home.ws-techs.com` **冇** `X-Robots-Tag`（正式站可以被 index）
- `propwatch.pages.dev`／preview branch 有 `X-Robots-Tag: noindex`
- robots.txt、sitemap.xml、og:image 張圖都 200

⚠️ **改 `_headers` 嗰陣要小心**：如果 `noindex` 規則寫錯套咗落 `home.ws-techs.com`，
成個網站會喺 Google 消失。每次 deploy 完都要 check：

```bash
curl -sI https://home.ws-techs.com/ | grep -i x-robots
```

（應該乜都冇出。）

---

## 2. 下一步（按影響力排）

### ① Google Search Console —— 最急

域名 2026-09-24 先啱啱轉，Google 可能仲未知有呢個網站。

1. 去 <https://search.google.com/search-console>，用你自己嘅 Google 帳戶登入
2. 加「網域」資源：`ws-techs.com`
3. Google 會畀一條 TXT record → 喺 Cloudflare DNS 加（Claude 可以幫手喺 dashboard 加）
4. 驗證完：Sitemaps → 提交 `https://home.ws-techs.com/sitemap.xml`
5. 網址審查 → 輸入 `https://home.ws-techs.com/` → 要求建立索引

之後喺 Search Console 睇「成效」，就知人哋搜咩字搵到你。

### ② 獨立按揭計算機頁 —— 最有價值嘅內容

「按揭計算機」「印花稅計算 2026」「按揭保險」嘅搜尋量遠高過其他字。
而家個計算機係 landing 頁嘅彈窗（`#calculator`），**Google 唔會當彈窗係一版獨立頁**。

要做：
- 獨立 URL（例如 `/mortgage-calculator`），有自己嘅 `<title>`、description、h1
- 頁面上用文字解釋 2026 印花稅稅階、按揭成數上限、按揭保費——Google 要「字」先識排
- 加入 sitemap
- 數字出處照 HANDOVER §6（稅務局、按證保險），寫明生效日期

### ③ 教學文章（長尾關鍵字）

搜尋量細，但競爭少、容易贏，而且啱我哋嘅受眾：
- 「點知一個盤放咗幾耐？」
- 「業主減咗幾多次價先算有得傾？」
- 「叫價同成交中位數差幾多先算抵？」
- 「刷新扮新盤係咩？點分辨？」

### ④ 外部連結（backlinks）

競爭大嘅字（例如「按揭計算機」）而家係銀行、中原、28Hse 霸住，
冇外部連結好難擠上去。可以喺香港討論區、Threads、Facebook 群組、blog 分享計算機或者教學文章。
呢部分要你自己做。

---

## 3. 刻意唔做嘅嘢

**唔整公開嘅逐屋苑數據頁**（例如「XX 屋苑放盤／成交」）。SEO 上好有用，
但會將 scrape 返嚟嘅數據公開俾人抽——違反 `CLAUDE.md` 嘅安全 convention
（數據係資產，要防止俾人拎去做類似系統）。如果將來要做，只可以出統計數字
（例如放盤數目、平均呎價），唔可以出逐個盤。

---

## 4. 實際期望

| 搜尋字 | 預計 |
|---|---|
| 「搵樓日記」（品牌名） | Search Console 提交後幾個星期內應該排第一 |
| 長尾字（教學文章嗰啲） | 有內容頁之後 1–3 個月 |
| 「按揭計算機」「印花稅計算」 | 要內容 + 外部連結，以月計，唔保證 |

---

## 5. 詳細審查（2026-09-25，實測數據）

量度方法：本機 Lighthouse 12（手機模擬、節流）、curl 檢查 header／狀態碼、
解析首頁 HTML 睇 Google 見到嘅文字同連結、WebSearch 睇對手排名。
（PageSpeed Insights API 匿名 quota 用完，所以改喺本機跑同一套引擎。）

### 5.1 Lighthouse 分數（手機）

| 頁面 | 效能 | 無障礙 | 最佳做法 | SEO | LCP | CLS |
|---|---|---|---|---|---|---|
| 首頁 `/` | 75 | 96 | 100 | 100 | **6.7 秒** ❌ | 0.063 ✅ |
| `/mortgage-calculator` | 82 | 91 | 100 | 100 | 1.0 秒 ✅ | **0.369** ❌ |

Google 標準：LCP ≤ 2.5 秒、CLS ≤ 0.1 先算「良好」。Core Web Vitals 係排名因素。

### 5.2 發現嘅問題（按影響排）

**A. 技術問題（可以即刻修，風險低）**

1. **Soft 404**：任何唔存在嘅網址（例如 `/abc-not-exist`）都回 **200** 同首頁
   內容。Google 會當係重複內容，亦會嘥 crawl budget。
   → 加 `frontend/404.html`（Cloudflare Pages 見到就會回真正嘅 404）。
2. **首頁 LCP 6.7 秒**：LCP 元素係 carousel 第一張圖（`hero-1-overview.jpg`，
   1000px、160KB）。細分：TTFB 0.8s、**等待開始下載 2.2s**（張圖排喺 509KB
   HTML 入面大約 150KB CSS 後面先被發現）、之後下載同 render。
   → `<head>` 加 `<link rel="preload" as="image" fetchpriority="high">`；
     張 `<img>` 加 `fetchpriority="high"`；圖片轉 WebP + `srcset`（手機只顯示
     372px 闊，而家下載 1000px）。Lighthouse 估計圖片可慳 **~800KB**。
3. **計算機頁 CLS 0.369**：表單由 `mortgage.js` 載入後先塞入 `#mc-form-host`，
   將下面成篇說明文字推落去。
   → 幫 `#mc-form-host` 預留高度（`min-height`），或者改做靜態 HTML。
4. **7 張圖冇 `width`／`height`**：會造成版面跳動，亦係 Lighthouse 扣分位。
5. **計算機表單 4 個 input 冇對應 `<label for>`**（無障礙扣分，亦影響 Google
   理解表單）。
6. `mortgage.js` 喺首頁係同步載入，擋住 render（13.8KB，細問題）。

**B. 內容同結構問題（影響大，要諗清楚先做）**

7. **首頁文字只有 39% 係宣傳內容**：Google 爬首頁見到 2,482 字，其中 1,529 字
   （61%）係 app 內部介面（登入表單、「新增朋友屋企」、睇樓偏好、設定…），
   因為成個 app 都喺同一個 `index.html`。會沖淡首頁主題，Google 仲有機會攞
   呢啲字做搜尋結果嘅描述。
   → 長遠做法：將 landing 同 app 分開（例如 app 搬去 `/app`），首頁淨係宣傳
     內容。改動大，要規劃。
8. **成個網站得 1 條內部連結**（首頁 → `/mortgage-calculator`）。其餘 177 個
   都係 `onclick` 掣，Google 唔會跟。冇 footer、冇「關於我們」、冇私隱政策、
   冇使用條款。
   → 加 footer 連結；加 `/privacy`（收 email 同 Stripe 付款，香港私隱條例角度
     本身都應該有）同 `/about`。呢啲亦係 Google 評估網站可信度（E-E-A-T）嘅訊號。
9. **冇 `WebSite`／`Organization` 結構化資料**：「搵樓日記」包含「搵樓」呢個
   普通字，Google 未必識得當佢係網站名。
   → 首頁加 `WebSite`（`name`＋`alternateName`）同 `Organization`（logo）。

**C. 關鍵字機會（WebSearch 睇對手）**

| 搜尋字 | 而家邊個排前 | 我哋機會 |
|---|---|---|
| 按揭計算機 2026、印花稅計算 | 中原按揭、mReferral、胡‧說樓市、MoneyHero、Zurich、千居 | 低：全部係大型內容網站，篇篇都係長篇「懶人包」 |
| 買得起幾錢樓 計算機 | 香港置業、滙豐、利嘉閣按揭、mReferral | 低至中 |
| 樓盤 放盤日數 減價 追蹤 | **冇一個網站專門講呢樣**，結果係一般搵樓網 | **高**：呢個係我哋獨有嘅題目 |
| 叫價 成交價 差距 抵唔抵 | 新聞同 blog 零散文章 | 中至高 |

→ 內容策略應該集中喺**我哋獨有嘅題目**（放盤日數、減價、刷新扮新盤、叫價同
  成交差距），唔好同中原、MoneyHero 硬碰「按揭計算機」。

**D. 站外**

10. Search Console「要求建立索引」頭兩次失敗（property 啱啱驗證），**要再試**。
11. 加 **Bing Webmaster Tools**（可以直接由 Search Console 匯入）：Bing 嘅索引
    亦係 ChatGPT 搜尋同 Copilot 用緊嘅資料來源。
12. Backlink：香港討論區、Threads、Facebook 群組分享（要你自己做）。

### 5.3 建議次序

1. **即刻做（A 組 1–6）**：技術修正，半日內做完，唔影響功能。
2. **跟住做**：B9（WebSite schema）、B8（footer＋私隱政策＋關於我們）。
3. **內容**：第一篇教學文章揀「點知一個盤放咗幾耐？刷新扮新盤點分辨」——
   冇對手、同產品功能直接相關、讀完自然想註冊。
4. **規劃**：B7（landing 同 app 分家），改動大，要另外傾。

### 5.4 A 組技術修正結果（2026-09-25 上線）

| 項目 | 點改 | 之前 → 之後 |
|---|---|---|
| Soft 404 | 加 `frontend/404.html`（`noindex`，有連結返首頁／計算機） | `/abc-not-exist` 200 → **404** |
| 首頁 LCP | 7 張圖轉 WebP + `srcset`（640／800／1000／1600）、`<head>` preload 第一張 hero、`fetchpriority`、carousel 第 2、3 張等 `load` 之後先載（`data-src`） | LCP 6.7s → **3.0s**；效能 75 → **93** |
| 計算機頁 CLS | `mortgage.js` 改喺表單位置同步載入即場 mount，唔再喺 `</body>` 前 | CLS 0.369 → **0**；效能 82 → **100** |
| 圖片闊高 | 全部 landing `<img>` 加 `width`／`height`（feature 圖 CSS 補 `height:auto`） | Lighthouse unsized-images ✅ |
| 表單標籤 | 計算機 9 個 `<label>` 加 `for`，花紅兩格加 `aria-label` | Lighthouse label ✅ |

原本嘅 JPG 保留（`og:image` 分享卡片用）。WebP 由 `sharp` 生成，quality 80。

**未解決：首頁 LCP 仲係 3.0s（標準 2.5s）。** 剩低主要係 TTFB（~0.9s）同
下載 509KB（br 後 137KB）HTML——成個 app 同 landing 擺喺同一個檔。要再落就要做
5.2 B7（landing 同 app 分家）。

### 5.5 B 組同內容（2026-09-25 上線）

**Landing 同 app 分家（5.2 B7）**
- `/`（`frontend/index.html`）：純靜態宣傳頁，24.5KB（之前成個 app 509KB）。
  `<head>` 最頂有 script：有 token 就 `location.replace("/app" + search + hash)`；
  舊 `/#calculator` 深 link 轉去 `/mortgage-calculator`。
- `/app`（`frontend/app.html`）：原本嘅 app，拎走 landing。`<meta robots noindex>`
  ＋ `_headers` `X-Robots-Tag: noindex`。未登入：`#login`／`#register` 開登入卡，
  其他情況轉返 `/`；閂登入卡返 `/`；登出／401 會 reload 去 `/app#login`
  （清走畫面上上一個帳戶嘅資料——以前靠 landing 蓋住）。
- worker／Stripe／email 全部指去 `/?...`，靠 landing 嗰段 redirect 帶去 `/app`，
  **唔使改 worker**。已測：`/?billing=cancel` → `/app` 並處理咗 query。
- 結果：首頁 Lighthouse 效能 **100**、LCP **1.4s**（5.4 之後仲係 3.0s）。
  首頁 Google 見到嘅文字全部係宣傳內容（之前 61% 係 app 介面）。

**新頁面**（全部用 `/site.css`、有 footer 內部連結、BreadcrumbList）
- `/guides/`、`/guides/listing-days`、`/guides/asking-vs-transaction`（Article schema）
- `/about`（AboutPage）、`/privacy`（照系統實際收集嘅資料寫；冇自助刪帳戶功能，
  所以寫 email 聯絡刪除——⚠️ 唔係法律意見，有需要搵律師睇）
- 首頁 JSON-LD 加 `WebSite`（name／alternateName）同 `Organization`。
- sitemap 由 2 版加到 7 版。

**Search Console**：重新提交 sitemap（狀態「成功」）；首頁、計算機、兩篇文章
「要求建立索引」全部成功（加入優先檢索佇列）。

**注意**：Cloudflare zone 開咗 Email Address Obfuscation，會改寫頁面上嘅
`mailto:`（加 `/cdn-cgi/.../email-decode.min.js`）。已驗證喺 CSP 下正常顯示。

**未做**
- Bing Webmaster Tools（要用你嘅帳戶登入授權）。
- 首頁 carousel 圖入面仲寫住舊名「HouseRadar」，要出新設計圖。
- 使用條款（涉及退款等商業決定，冇寫）。
