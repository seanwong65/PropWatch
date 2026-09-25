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
