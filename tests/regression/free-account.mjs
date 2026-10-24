#!/usr/bin/env node
// 免費帳戶 regression（API 層）：逐個免費功能打真 API，驗證狀態碼／收費擋位／帳戶隔離／上限，並量回應時間。
//   PW_TOKEN=<免費帳戶 token> [PW_API=https://propwatch-worker.johnwong777.workers.dev] [PW_ESTATE=<已追蹤屋苑 id>] node tests/regression/free-account.mjs
// token 攞法：登入 app → DevTools → localStorage.propwatch_token。⚠️ 唔好用收費／admin token（會令 402 測試失敗）。
// 會寫入嘅測試（睇樓記錄、朋友屋企、心儀樓盤、分享）一律標 [REGTEST]，測完逐個刪走；撞到上限檢查要有足夠空位。
const API = process.env.PW_API || "https://propwatch-worker.johnwong777.workers.dev";
const TOKEN = process.env.PW_TOKEN;
if (!TOKEN) { console.error("缺 PW_TOKEN"); process.exit(2); }
const rows = [];
let failed = 0;
async function call(name, path, { method = "GET", body, expect = [200], auth = true, raw = false } = {}) {
  const t0 = performance.now();
  let st, json = null;
  try {
    const r = await fetch(API + path, { method, headers: { ...(auth ? { Authorization: "Bearer " + TOKEN } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    st = r.status; const txt = await r.text(); try { json = JSON.parse(txt); } catch (_) {}
  } catch (e) { st = "ERR " + e.message; }
  const ms = Math.round(performance.now() - t0), ok = expect.includes(st);
  rows.push({ name, st, ms, ok }); if (!ok) failed++;
  return json;
}
const check = (name, cond) => { rows.push({ name, st: cond ? "✓" : "✗", ms: 0, ok: !!cond }); if (!cond) failed++; };

// ── 0. 身份：一定要係免費帳戶 ──
const cfg = await call("config", "/api/config");
if (cfg?.tier !== "free" || cfg?.role !== "user") { console.error(`呢個 token 唔係免費帳戶（tier=${cfg?.tier} role=${cfg?.role}），中止`); process.exit(2); }
const est = (await call("estates", "/api/estates"))?.estates || [];
const E = Number(process.env.PW_ESTATE || est[0]?.id);
if (!E) { console.error("帳戶冇追蹤屋苑，請設 PW_ESTATE 或者先追蹤一個"); process.exit(2); }

// ── 1. 未登入／壞 token → 401 ──
for (const p of ["/api/estates", "/api/viewings/all", "/api/config", "/api/preferences", "/api/friend-homes", "/api/favourite-listings", "/api/shares"])
  await call("401 無 token " + p, p, { auth: false, expect: [401] });
const bad = await fetch(API + "/api/estates", { headers: { Authorization: "Bearer deadbeef" } });
check("401 壞 token", bad.status === 401);

// ── 2. 免費功能 → 200 ──
await Promise.all([
  ["listings", `/api/estates/${E}/listings`], ["transactions", `/api/estates/${E}/transactions`], ["market-temp", `/api/estates/${E}/market-temp`],
  ["estate-info", `/api/estates/${E}/estate-info`], ["crowd", `/api/estates/${E}/crowd`], ["rental-listings", `/api/estates/${E}/rental-listings`],
  ["rental-transactions", `/api/estates/${E}/rental-transactions`], ["group-overrides", `/api/estates/${E}/group-overrides`], ["photos", `/api/estates/${E}/photos`],
  ["today-highlights", "/api/today-highlights"], ["preferences", "/api/preferences"], ["settings", "/api/settings"], ["shares", "/api/shares"],
  ["listing-clicks/mine", "/api/listing-clicks/mine"], ["viewings/photo-status", "/api/viewings/photo-status"], ["viewings/all", "/api/viewings/all"],
  ["viewings?estate_id", `/api/viewings?estate_id=${E}`], ["friend-homes", "/api/friend-homes"], ["favourite-listings", "/api/favourite-listings"], ["favourite-listings/refs", "/api/favourite-listings/refs"],
].map(([n, p]) => call("200 " + n, p)));
const adv = await call("200 adv-search（免費篩選）", "/api/adv-search", { method: "POST", body: { deal: "S", price_max: 900 } });
check("adv-search 回 results", Array.isArray(adv?.results));

// ── 3. 收費功能 → 402（server 端擋，唔靠前端收埋個掣）──
for (const [n, p] of [["trends", `/api/estates/${E}/trends`], ["rental-trends", `/api/estates/${E}/rental-trends`], ["market-index", "/api/market-index"],
  ["hangseng-valuation", "/api/hangseng-valuation"], ["hangseng-valuation-history", "/api/hangseng-valuation-history"], ["history-highlights", "/api/history-highlights"],
  ["viewings/comps", "/api/viewings/comps"], ["bargain-radar", "/api/bargain-radar"], ["estate-comps", "/api/estate-comps"], ["listing history", "/api/listings/ABC123/history"]])
  await call("402 " + n, p, { expect: [402] });
// 恒生估值：免費版只有「試用」（?trial=自己嘅睇樓記錄 id，server 驗單位＋計次數）。呢度只測唔會消耗次數嘅部分。
await call("402 恒生估值 無 trial", `/api/hangseng-valuation?estate=x&estateId=${E}&block=1&floor=1&flat=A`, { expect: [402] });
await call("402 恒生估值 trial 唔屬於自己", `/api/hangseng-valuation?estate=x&estateId=${E}&block=1&floor=1&flat=A&trial=99999999`, { expect: [402] });
check("config 有試用次數欄位", typeof cfg.hsTrialCap === "number" && typeof cfg.hsTrialsLeft === "number");
await call("402 adv-search 放盤日數", "/api/adv-search", { method: "POST", body: { deal: "S", dom_min: 30 }, expect: [402] });
const L = await call("listings（收費欄位）", `/api/estates/${E}/listings`);
check("免費 listings tierLimited", L?.tierLimited === true);
check("免費 listings 冇 first_seen／prev_price／dom", (L?.listings || []).every((x) => x.first_seen == null && x.prev_price == null && x.dom_days == null && x.removed_date == null));

// ── 4. 帳戶隔離／權限 ──
const other = Number(process.env.PW_UNTRACKED_ESTATE || (E === 7 ? 8 : 7));
await call("404 未追蹤屋苑 listings", `/api/estates/${other}/listings`, { expect: [404] });
await call("404 未追蹤屋苑 transactions", `/api/estates/${other}/transactions`, { expect: [404] });
await call("404 未追蹤屋苑 crowd", `/api/estates/${other}/crowd`, { expect: [404] });
await call("404 sync 未追蹤屋苑", `/api/sync?estateId=${other}`, { method: "POST", expect: [404] });
for (const [n, p, m] of [["admin usage-stats", "/api/admin/usage-stats"], ["admin feedback", "/api/admin/feedback"], ["admin sync-status", "/api/admin/sync-status"], ["admin listing-clicks", "/api/admin/listing-clicks"],
  ["admin tiers", "/api/admin/tiers", "POST"], ["admin preview-daily", "/api/admin/preview-daily", "POST"], ["admin run-weekly", "/api/admin/run-weekly-task", "POST"], ["test-email", "/api/test-email", "POST"], ["send-today-email", "/api/send-today-email", "POST"]])
  await call("403 " + n, p, { method: m || "GET", expect: [403] });
await call("config PUT（免費唔准改分析參數）", "/api/config", { method: "PUT", body: {}, expect: [403] });
await call("400 公開搜尋白名單", "/api/public/search?src=bogus", { auth: false, expect: [400] });
await call("404 公開分享 假 token", "/api/public/share", { method: "POST", body: { t: "a".repeat(64) }, auth: false, expect: [404] });
await call("400 公開分享 格式錯", "/api/public/share", { method: "POST", body: { t: "zz" }, auth: false, expect: [400] });

// ── 5. 睇樓記錄 CRUD ＋ 免費遮蓋 ＋ XSS 字串原樣存取 ──
const created = [];
const mk = await call("睇樓 新增", "/api/viewings", { method: "POST", body: { estate_id: E, view_date: "2026-10-25", block: "1座", floor: "10", unit: "A", size_net: 400, price: 6000000, notes: "[REGTEST] <img src=x onerror=alert(1)>", bedrooms: 2, deal_type: "S" } });
if (mk?.id) created.push(mk.id);
const all = await call("睇樓 列表", "/api/viewings/all");
const mine = all?.viewings?.find((v) => v.id === mk?.id);
check("新增後見到", !!mine);
check("免費遮走分析欄位", mine && mine.vs_med_pct == null && mine.dom_days == null && mine.market_basis == null && all.tierLimited === true);
if (mine) {
  await call("睇樓 修改", `/api/viewings/${mine.id}`, { method: "PUT", body: { estate_id: E, view_date: "2026-10-25", block: "1座", floor: "11", unit: "A", size_net: 410, price: 6100000, notes: "[REGTEST] edited", bedrooms: 2 } });
  const one = await call("睇樓 按屋苑（詳情卡用）", `/api/viewings?estate_id=${E}`);
  check("修改生效", one?.viewings?.find((v) => v.id === mine.id)?.floor === "11");
  const sh = await call("分享 建立", "/api/shares", { method: "POST", body: { viewing_ids: [mine.id], kind: "viewing", opts: { photos: false, price: true, ratings: false, notes: false } } });
  if (sh?.token) {
    const pub = await call("公開分享頁（讀）", "/api/public/share", { method: "POST", body: { t: sh.token }, auth: false });
    const leak = ["hs_price", "linked_ref_no", "vs_med_pct", "sold_med_psf", "account_id"].filter((k) => JSON.stringify(pub).includes(k));
    check("分享頁冇漏分析／帳戶欄位", leak.length === 0);
    await call("分享 取消", `/api/shares/${sh.id}`, { method: "DELETE" });
    await call("取消後 404", "/api/public/share", { method: "POST", body: { t: sh.token }, auth: false, expect: [404] });
  }
}
for (const id of created) await call("睇樓 刪除", `/api/viewings/${id}`, { method: "DELETE" });

// 座數可以留空（單幢屋苑）：API 照收，唔報錯；前端會用屋苑名補（見 NOTES「座數」）
const nb = await call("睇樓 新增（冇座數）", "/api/viewings", { method: "POST", body: { estate_id: E, view_date: "2026-10-25", floor: "10", unit: "B", size_net: 400, price: 6000000, notes: "[REGTEST] no block", deal_type: "S" } });
if (nb?.id) {
  const lst = await call("睇樓 列表（含冇座數）", "/api/viewings/all");
  check("冇座數記錄見到、唔爆", !!lst?.viewings?.find((v) => v.id === nb.id));
  await call("睇樓 刪除（冇座數）", `/api/viewings/${nb.id}`, { method: "DELETE" });
}

// ── 6. 朋友屋企：免費上限（預設 3，由 /api/config 讀）──
const cap = cfg.freeMaxFriendHomes ?? 3, have = (await call("朋友屋企 現有", "/api/friend-homes"))?.homes?.length || 0;
if (have + 1 <= cap) {
  const ids = [];
  for (let i = have; i < cap; i++) { const r = await call(`朋友屋企 新增 ${i + 1}/${cap}`, "/api/friend-homes", { method: "POST", body: { friend_name: "[REGTEST] " + i, estate_id: E, block: "1座", floor: String(i + 1), unit: "A" } }); if (r?.id) ids.push(r.id); }
  await call("朋友屋企 超上限 → 402", "/api/friend-homes", { method: "POST", body: { friend_name: "[REGTEST] over", estate_id: E, block: "1座", floor: "99", unit: "A" }, expect: [402] });
  for (const id of ids) await call("朋友屋企 刪除", `/api/friend-homes/${id}`, { method: "DELETE" });
} else check("朋友屋企：帳戶已滿，跳過", true);

// ── 7. 心儀樓盤 ──
const ref = L?.listings?.[0]?.ref_no;
if (ref) {
  await call("心儀 新增", "/api/favourite-listings", { method: "POST", body: { estate_id: E, refs: [ref], deal: "S" } });
  const f = await call("心儀 列表", "/api/favourite-listings");
  check("免費版心儀改價記錄鎖住", f?.history_locked === true);
  await call("心儀 刪除", `/api/favourite-listings?ref=${encodeURIComponent(ref)}&deal=S`, { method: "DELETE" });
}

// ── 8. 偏好 round-trip（還原）──
const p0 = await call("偏好 讀", "/api/preferences");
await call("偏好 寫", "/api/preferences", { method: "PUT", body: { price_max: 800, beds: "2", deal_types: ["S"] } });
check("偏好 寫入生效", (await call("偏好 再讀", "/api/preferences"))?.prefs?.price_max === 800);
await call("偏好 還原", "/api/preferences", { method: "PUT", body: { ...(p0?.prefs || { deal_types: ["S"] }), email_opt_in: p0?.email_opt_in } });
await call("400 意見回饋 空", "/api/feedback", { method: "POST", body: {}, expect: [400] });

// ── 報告 ──
const timed = rows.filter((r) => r.ms).map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => timed[Math.min(timed.length - 1, Math.floor(timed.length * p))];
for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${String(r.st).padEnd(4)} ${String(r.ms).padStart(5)}ms  ${r.name}`);
const slow = rows.filter((r) => r.ms > Number(process.env.PW_SLOW_MS || 2500)).map((r) => `${r.name} ${r.ms}ms`);
console.log(`\n${rows.length - failed}/${rows.length} 通過｜回應時間 p50=${pct(0.5)}ms p90=${pct(0.9)}ms max=${timed.at(-1)}ms`);
if (slow.length) console.log("偏慢（>" + (process.env.PW_SLOW_MS || 2500) + "ms）：\n  " + slow.join("\n  "));
process.exit(failed ? 1 : 0);
