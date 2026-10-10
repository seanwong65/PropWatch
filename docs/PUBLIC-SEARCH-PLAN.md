# 首頁公開搜尋（未登入）— 開發計劃 v2

寫於 2026-10-09，取代 v1（v1 係「搜自己 DB 嘅每日快照」，用戶否決）。

**目標**：好似 SEEHSE 搵樓街咁，未登入都可以用條件（地區、屋苑、價錢、面積、房數…）搜尋；
**搜嘅係地產網站本身，唔係我哋 DB**。結果顯示基本資料，撳就帶去原網站（似 Google）。
搜尋做入口，再用「追蹤加減價要登記」吸引人做會員。

---

## 1. 可行性（2026-10-09 實測，全部只讀）

| 網站 | 點樣搜 | 驗證咗嘅條件 | 結果量 | 速度 |
|---|---|---|---|---|
| **中原** | `POST hk.centanet.com/findproperty/api/Post/Search` | `keyword`（屋苑）、`amountRange`（價錢，HK$）、`nSizeRange`（實呎）、`bedroomCount:[2]`、`buildingAgeRange`、`hmas`（地區）、`postType` Sale/Rent | 全港買盤 35,161 | 0.2–0.8 秒（冷啟動試過 4.8 秒） |
| **美聯** | `GET data.midland.com.hk/search/v2/properties`（匿名 token，由網頁攞，已有 30 分鐘 cache） | `price=最低-最高`、`rent=`、`bedroom`、`net_area=最低-最高`、`dist_ids`、`subregion_ids`、`est_ids`、`tx_type` S/L | 全港買盤 32,833 | 0.2–0.5 秒 |
| **香港置業** | `GET data.hkp.com.hk/search/v1/properties`（同美聯同一後台） | 同美聯 | 全港買盤 7,871 | 0.2–0.6 秒 |
| **利嘉閣** | 冇 JSON API，要抓 HTML；而且佢 WAF 會擋 IP（我部機而家都被擋） | — | — | — |

例子（真實結果）：「全港 · 2房 · $500–800萬 · 400–600呎」→ 中原 4,773、美聯 4,601、香港置業 1,190。

- 每個結果都有原網站連結（中原 `detailUrl`、美聯／置業 `url_desc`），可以直接帶人過去。
- **地區**：中原有完整地區樹（`/findproperty/api/Place/GetHmaPlaces`：4 大區 → 55 區 → 178 細區）；
  美聯／置業用自己嘅地區代碼（`subregion_ids` 約 18 區、`dist_ids` 細區）。要一次過砌一張對照表（按中文地名對，再人手執）。
- 我哋 app 入面「屋苑 search」其實已經係即時問中原同美聯（`searchEstatesAllSources`），今次係將同一個做法擴大到有條件嘅放盤搜尋。

---

## 2. 架構

```
訪客瀏覽器 ──► GET /api/public/search?deal=S&area=…&kw=…&beds=2&price=500-800&size=400-600&page=1
                 │  （Worker，唔掂 D1）
                 ├─ Cache API 命中？→ 直接回（同一組條件 15 分鐘內唔再問地產網）
                 ├─ 並行問：中原 Post/Search ｜ 美聯 properties ｜ 香港置業 properties（每個 6 秒 timeout）
                 ├─ 統一格式：網站、屋苑、座／層、地區、房、實呎、價錢、呎價、上架日、原網站連結
                 └─ 回傳：每個網站嘅總數 + 每頁每網 ~12 個結果（某個網站失敗就照出其他，註明「暫時搵唔到」）
```

- **D1 負載：0**。路由放喺 `handleRequest` 最頂（`ensure*` 之前），限速用記憶體計數，`getSecCfg` 每分鐘每 isolate 最多讀 1 次 settings。
- **限速**：新 `sec_public_search_rpm`（建議每 IP 每分鐘 20 次）＋ 每次最多翻 5 頁；`sec_public_search_enabled` 做緊急開關（被地產網封就即刻關）。
- **Token**：美聯已有 30 分鐘 cache；香港置業個 token 而家每次都重新攞，要加同樣 cache。
- **搜尋記錄**：用 Workers Logs（`console.log` 已正規化嘅條件），**唔寫 D1**；之後想要每日統計先加 aggregate。
- **前端**：首頁 hero 下面加搜尋區；另開 `/search?…` 結果頁（條件喺 URL，可以分享／收藏）；
  新 `frontend/public-search.js`（跟 `mortgage.js` 做法），搬埋 `escHtml`／`safeUrl` helpers（地產網資料當唔可信）。
  CSP `connect-src` 已經准 worker host，唔使改。
- **利嘉閣**：第 1 期只做「去利嘉閣搵呢個屋苑 ↗」連結（`ricacorpUrlFor(name)` 已有），唔代抓。

---

## 3. 點樣吸引人登記（轉化）

- 每張結果卡：**「🔔 追蹤呢個屋苑嘅加減價」** → `/app?track_name=<屋苑>#register`，登記完自動追蹤（跟 `?mc_budget=` 前例）。
- 結果頂部一條：「地產網唔會話你個盤放咗幾耐、減過幾多次價——免費登記，由今日開始幫你記錄。」
- 搜尋嘅屋苑**已經有我哋追蹤**（喺 `estates` 表）→ 卡上加「📈 有歷史記錄」標記（要再查 1 次 D1，可以由一份每日更新嘅屋苑名單做，唔使逐次查）——第 2 期。

---

## 4. 風險

1. **被地產網限流／封鎖**：公開流量會令我哋問地產網嘅次數大增，而 worker 同時負責每日 sync。
   緩解：15 分鐘 cache、每 IP 限速、緊急開關、每頁數量細。真係出事可以將公開搜尋搬去另一個 worker（獨立 script，唔影響 sync 嘅 subrequest 預算）。
2. **條款／法律**：公開轉載地產網放盤資料；我哋只出基本欄位、唔存、唔出相、每個結果都連返原網站，並加「資料由第三方提供」聲明（同 SEEHSE 一樣）。
3. **`CLAUDE.md` 規矩**：要加一條例外——`/api/public/search` 只讀**地產網**資料、唔掂 D1、唔回任何帳戶資料、有 cache 同限速。
4. **Workers Free 每次請求 CPU 10ms**：每次 parse 3 份 JSON；中原一頁 24 個盤已經喺 sync 做緊，預計 OK，上線前要實測。

---

## 5. 分期同工作量

**第 1 期（約 3–4 日）**
1. 地區對照表：script 由中原地區樹＋美聯／置業代碼砌一份 `frontend/hk-areas.json`，人手執（0.5–1 日）
2. Worker `GET /api/public/search`：三網並行、統一格式、cache、限速、開關、unit test（1 日）
3. 首頁搜尋區 + `/search` 結果頁 + 登記 handoff（`track_name`）（1–1.5 日）
4. 測試同上線：冇 token 都 200、限速 429、cache 命中、一個網站死咗照出其他、XSS 測試（0.5 日）

**第 2 期（可揀）**：同一單位跨網合併（重用而家 4 網合併規則）、「有歷史記錄」標記、利嘉閣代抓、
地圖、分享去 WhatsApp、按揭月供、估值對比（香港置業結果有 `valuation` 欄位，未研究）。

---

## 6. 決定（2026-10-10 用戶回覆）

1. ✅ 加 `/api/public/search` 公開 route，`CLAUDE.md` 已加規矩。
2. ✅ 首頁搜尋框 + 獨立 `/search` 結果頁（條件喺 URL）。
3. ✅ 每 IP 每網站每分鐘 20 次（`sec_public_search_rpm`）。
4. ❌ 利嘉閣唔可以淨係出連結——「人地個網都有result 點解我做唔到？」→ 改用利嘉閣網站自己嘅
   JSON API（`/zh-hk/property/api/post`）代抓買盤；租盤參數未搵到。
5. ➕ 要好似登入後咁顯示樓盤相片 → 四網都出縮圖（直接熱連結，CSP 加 host）。

上面第 2、4 節講「唔出相」「利嘉閣只出連結」已經被呢度取代；實作細節以 `docs/NOTES.md`
「公開搜尋」為準。
