# Regression 測試（免費帳戶）

兩層，改完 code／deploy 前後都跑：

| 檢查 | 指令 | 捉咩 |
|---|---|---|
| 前端靜態 | `bash tests/regression/check-frontend.sh` | 語法錯、**未定義函數／變數**（例：函數被刪但呼叫位仲喺度 → 免費用戶睇樓詳情永遠「載入詳情…」） |
| 免費帳戶 API | `PW_TOKEN=<免費 token> node tests/regression/free-account.mjs` | 免費功能 200、收費功能 402、帳戶隔離、admin 403、上限（朋友屋企 3）、公開分享頁唔漏分析、XSS 字串原樣、回應時間 p50/p90 |
| worker 單元 | `cd worker && npx vitest run` | 純函數（email／估值統計／feedback…） |

## 免費帳戶 API 腳本
- `PW_TOKEN`：登入免費測試帳戶後，`localStorage.propwatch_token`。腳本會檢查 `tier=free`、`role=user`，唔係就中止。
- `PW_API`：預設 production worker；本機測用 `http://localhost:8787`（`wrangler dev --local`，要喺 local D1 開臨時免費帳戶＋session＋追蹤一個屋苑，測完刪）。
- `PW_ESTATE`（已追蹤屋苑 id，預設第一個）、`PW_UNTRACKED_ESTATE`（未追蹤，用嚟驗 404）、`PW_SLOW_MS`（偏慢門檻，預設 2500）。
- 會寫入嘅測試全部標 `[REGTEST]` 並即刻刪走；偏好會還原。
- 手動 UI 清單（腳本蓋唔到）：登入 → 睇樓日記撳開詳情（唔好卡住）→ 朋友屋企／心儀樓盤／今日動態 tab → 屋苑頁（放盤／成交／睇樓記錄／樓盤分析鎖）→ 升級 modal → `/search` 搜尋。
