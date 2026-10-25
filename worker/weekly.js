// 每週摘要（收費版，逐個帳戶、只計「最愛」屋苑）。
// 分三層，方便單獨測試：
//   loadWeeklyInputs  — 淨係讀 D1（全部 scope 返 account_id／account_estates）
//   computeWeekly     — 純計算，冇 I/O
//   renderWeeklyHtml  — 純排版，動態字串一律 esc()
// 設計決定（用戶 2026-10-22 睇過樣本 v2 後定）：只講最愛屋苑；本週冇變動嘅盤唔顯示；
// 冇「同座成交對比」；數據唔夠就寫「數據累積中」，唔扮有。

const DAY = 86400000;
const isoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);
const median = (xs) => {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const pct = (a, b) => (a && b ? (a / b - 1) * 100 : null);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 最新一份 snapshot 要夠新（≤ STALE_DAYS 日前），否則呢個屋苑今次唔計（防止用舊數據扮「本週」）
export const WEEKLY_STALE_DAYS = 1;
// 上週 snapshot 允許偏離「7 日前」幾多日；偏太遠就當冇上週數據（寧願「數據累積中」都唔好亂比較）
const PREV_TOLERANCE_DAYS = 3;

// ── 1. 讀 D1 ────────────────────────────────────────────────────────────────
export async function loadWeeklyInputs(db, accountId, wEnd, prefs) {
  if (!isoDate(wEnd)) throw new Error("bad wEnd");
  const { results: ests } = await db.prepare(
    `SELECT ae.estate_id AS id, e.name FROM account_estates ae JOIN estates e ON e.id = ae.estate_id
     WHERE ae.account_id = ? AND ae.paused_at IS NULL AND ae.is_favourite = 1
     ORDER BY ae.sort_order ASC, ae.estate_id ASC`).bind(accountId).all();
  if (!ests.length) return { favourites: [] };
  const ids = ests.map((e) => Number(e.id)).filter(Number.isInteger).join(",");

  const wStart = addDays(wEnd, -6);
  // 有 snapshot 嘅日子：用 sync_log（每屋苑每 source 每日一行，好細），唔好 GROUP BY listings（會掃晒屋苑近 40 日全部放盤，
  // 一個屋苑 ~3 萬 rows read）。sync_date 同 listings.snapshot_date 係同一日。
  const { results: dateRows } = await db.prepare(
    `SELECT DISTINCT estate_id, sync_date AS d FROM sync_log
     WHERE estate_id IN (${ids}) AND kind = 'listings' AND ok = 1 AND sync_date >= ? AND sync_date <= ?`).bind(addDays(wEnd, -40), wEnd).all();
  const dates = {};
  for (const r of dateRows) (dates[r.estate_id] ||= []).push(r.d);
  const pick = (eid, target) => (dates[eid] || []).filter((d) => d <= target).sort().pop() || null;
  const snap = {};
  for (const e of ests) {
    const nowD = pick(e.id, wEnd);
    let prevD = nowD ? pick(e.id, addDays(nowD, -7)) : null;
    let m4D = nowD ? pick(e.id, addDays(nowD, -28)) : null;
    if (prevD && Math.abs(daysBetween(prevD, addDays(nowD, -7))) > PREV_TOLERANCE_DAYS) prevD = null;
    if (m4D && Math.abs(daysBetween(m4D, addDays(nowD, -28))) > PREV_TOLERANCE_DAYS * 2) m4D = null;
    snap[e.id] = { nowD, prevD, m4D };
  }
  const conds = ests.filter((e) => snap[e.id].nowD).map((e) => {
    const ds = [...new Set([snap[e.id].nowD, snap[e.id].prevD, snap[e.id].m4D].filter(isoDate))];
    return `(estate_id = ${Number(e.id)} AND snapshot_date IN (${ds.map((d) => `'${d}'`).join(",")}))`;
  });
  const listings = conds.length ? (await db.prepare(
    `SELECT estate_id, snapshot_date AS d, source, ref_no, building_name AS b, floor AS f, unit AS u, bedrooms AS beds,
            size_net AS s, price AS p, price_per_ft AS psf, detail_url AS url
     FROM listings WHERE ${conds.join(" OR ")}`).all()).results : [];
  const txnFrom = addDays(wEnd, -90);
  const txns = (await db.prepare(
    `SELECT estate_id, building AS b, floor AS f, unit AS u, price AS p, size_net AS s, price_per_ft AS psf, reg_date, first_seen
     FROM transactions WHERE estate_id IN (${ids}) AND reg_date >= ?`).bind(txnFrom).all()).results;   // OR first_seen 會令 index 用唔到；新成交一向只計近 90 日登記（同每日 email new_txn_max_age_days 一致）
  const favListings = (await db.prepare(
    `SELECT estate_id, ref_no FROM listing_favourites WHERE account_id = ? AND deal = 'S' AND estate_id IN (${ids})`).bind(accountId).all()).results;
  const viewings = (await db.prepare(
    `SELECT estate_id, view_date, block, floor, unit, size_net, linked_ref_no FROM viewings
     WHERE account_id = ? AND estate_id IN (${ids}) AND linked_ref_no IS NOT NULL AND linked_ref_no != ''
     ORDER BY view_date DESC LIMIT 40`).bind(accountId).all()).results;
  // 待跟進（睇樓記錄欠資料／未對應放盤）：同 app 內「待跟進」同一套規則（見 weeklyTodos）。全部睇樓記錄（唔止最愛屋苑）。
  // sold：同單位有登記日 ≥ 睇樓日嘅成交（走 idx_txn_unit；building 兼容「X座」同單幢屋苑嘅屋苑名）。v.* 唔點名欄位，因為 dismissed_refs 係 lazy ALTER 出嚟。
  let todoViewings = [], todoDismissed = [], todoLinkMaxDays = 30;
  try {
    todoViewings = (await db.prepare(
      `SELECT v.*, e.name AS estate_name,
         EXISTS (SELECT 1 FROM transactions t WHERE t.estate_id = v.estate_id
           AND t.building IN (CASE WHEN v.block LIKE '%座' THEN v.block ELSE v.block || '座' END, v.block)
           AND t.floor = CASE WHEN v.floor LIKE '%樓' OR v.floor LIKE '%層' THEN v.floor ELSE v.floor || '樓' END
           AND t.unit  = CASE WHEN v.unit LIKE '%室' OR v.unit LIKE '%號' THEN v.unit ELSE v.unit || '室' END
           AND t.reg_date >= v.view_date) AS sold
       FROM viewings v JOIN estates e ON e.id = v.estate_id
       WHERE v.account_id = ? ORDER BY v.view_date DESC LIMIT 200`).bind(accountId).all()).results;
    const kv = (await db.prepare("SELECT key, value FROM settings WHERE key IN (?, ?)")
      .bind(`todo_dismissed_${accountId}`, `cfg_${accountId}_todo_link_max_days`).all()).results;
    for (const r of kv) {
      if (r.key === `todo_dismissed_${accountId}`) { try { todoDismissed = (JSON.parse(r.value) || []).map(Number); } catch (_) {} }
      else if (Number(r.value) > 0) todoLinkMaxDays = Number(r.value);
    }
  } catch (_) { /* 待跟進只係額外 section，讀唔到就唔出，唔影響成封摘要 */ }
  return { favourites: ests, wStart, wEnd, snap, listings, txns, txnFrom, favListings, viewings, prefs: prefs || {}, todoViewings, todoDismissed, todoLinkMaxDays };
}

// 待跟進：同 frontend viewingTodos() 一致——
//   · 已成交（sold）／用戶 ✕ 唔再提醒（dismissed）嘅唔提；
//   · 欠資料：座／樓層／室／睇樓價（租盤叫睇樓租金），冇時限；
//   · 未對應放盤：有座＋室、冇 linked_ref_no；睇樓超過 linkMaxDays（預設 30）日唔再提（多數已賣／落架）；
//     dismissed_refs 有內容＝用戶逐個睇過全部 ✕，server 睇唔到候選放盤，保守當睇完。
export function weeklyTodos({ viewings = [], dismissed = [], linkMaxDays = 30, today }) {
  const hidden = new Set((dismissed || []).map(Number));
  const items = [];
  for (const v of viewings || []) {
    if (!v || v.sold || hidden.has(Number(v.id))) continue;
    const missing = [];
    if (!v.block) missing.push("座");
    if (!v.floor) missing.push("樓層");
    if (!v.unit) missing.push("室");
    if (!v.price) missing.push(v.deal_type === "R" ? "睇樓租金" : "睇樓價");
    let needLink = !!(v.block && v.unit) && !String(v.linked_ref_no || "").trim();
    if (needLink && isoDate(String(v.view_date || "").slice(0, 10)) && isoDate(today)
        && daysBetween(String(v.view_date).slice(0, 10), today) > linkMaxDays) needLink = false;
    if (needLink) { try { if ((JSON.parse(v.dismissed_refs || "[]") || []).length) needLink = false; } catch (_) {} }
    if (missing.length || needLink) items.push({ id: v.id, estate: v.estate_name || "", block: v.block || "", floor: v.floor || "", unit: v.unit || "", viewDate: v.view_date || "", missing, needLink });
  }
  items.sort((a, b) => String(b.viewDate).localeCompare(String(a.viewDate)));   // 最近睇嘅排先（記憶仲新，最易補）
  return { total: items.length, items };
}

// ── 2. 計算（純函數）─────────────────────────────────────────────────────────
export function computeWeekly(inp) {
  if (!inp.favourites.length) return { status: "skip", reason: "no_favourites" };
  const { wStart, wEnd, snap, listings, txns, txnFrom, favListings, viewings } = inp;
  const prefs = inp.prefs || {};
  const name = Object.fromEntries(inp.favourites.map((e) => [e.id, e.name]));

  // 過期嘅屋苑唔計
  const stale = [];
  const fresh = inp.favourites.filter((e) => {
    const nd = snap[e.id]?.nowD;
    const ok = nd && daysBetween(nd, wEnd) <= WEEKLY_STALE_DAYS;
    if (!ok) stale.push(e.name);
    return ok;
  });
  if (!fresh.length) return { status: "skip", reason: "stale_data", stale };

  const unitKey = (r) => `${r.b || ""}|${r.f || ""}|${r.u || r.ref_no}|${Math.round(r.s || 0)}`;
  const active = (eid, d) => {
    const seen = new Map();
    for (const r of listings) if (r.estate_id === eid && r.d === d && (r.p || 0) > 0 && !seen.has(unitKey(r))) seen.set(unitKey(r), r);
    return [...seen.values()];
  };
  // 新盤／下架／減價：全部由「最新 vs 上週」兩份 snapshot 比（唔使掃 listing_price_history 大表）。
  // 只比兩份都有 snapshot 嘅 source，否則新加入嘅 source 會令全部盤變新盤。
  const priceMap = (eid, d) => new Map(listings.filter((r) => r.estate_id === eid && r.d === d).map((r) => [r.ref_no, r]));
  const prevPrice = {};   // ref_no → 上週嗰份 snapshot 嘅價（俾「你留意緊嘅盤」比較用）
  for (const r of listings) if (snap[r.estate_id] && r.d === snap[r.estate_id].prevD) prevPrice[r.ref_no] = r.p;

  // 睇樓偏好（跟每日 email 一樣：價錢單位萬、房數 '1'..'4+'、實用呎）
  const prefsUsable = !!(prefs.price_min || prefs.price_max || prefs.beds || prefs.size_min || prefs.size_max);
  const prefOk = (r) => {
    if (prefs.price_max && r.p > prefs.price_max * 1e4) return false;
    if (prefs.price_min && r.p < prefs.price_min * 1e4) return false;
    if (prefs.beds && r.beds != null && (prefs.beds === "4+" ? r.beds < 4 : String(r.beds) !== String(prefs.beds))) return false;
    if (prefs.size_min && r.s != null && r.s < prefs.size_min) return false;
    if (prefs.size_max && r.s != null && r.s > prefs.size_max) return false;
    return true;
  };
  const cutRows = [];                    // 本週減價（逐個盤）
  let budgetNow = 0, budgetPrev = 0, budgetPrevOk = true;
  const cards = [];
  for (const e of fresh) {
    const { nowD, prevD, m4D } = snap[e.id];
    const now = active(e.id, nowD), prev = prevD ? active(e.id, prevD) : [], m4 = m4D ? active(e.id, m4D) : [];
    const psfOf = (rows) => median(rows.map((r) => r.psf).filter(Boolean));
    const aNow = psfOf(now), aPrev = psfOf(prev), aM4 = psfOf(m4);
    const tx90 = txns.filter((t) => t.estate_id === e.id && (t.reg_date || "") >= txnFrom && t.psf);
    const txw = txns.filter((t) => t.estate_id === e.id && (t.first_seen || "") >= wStart);
    const tMed = median(tx90.map((t) => t.psf));
    const gap = pct(aNow, tMed);
    const mNow = priceMap(e.id, nowD), mPrev = prevD ? priceMap(e.id, prevD) : new Map();
    const both = new Set([...mNow.values()].map((r) => r.source).filter((src) => [...mPrev.values()].some((x) => x.source === src)));
    let newN = 0, removed = 0;
    const cuts = [];
    for (const [ref, r] of mNow) {
      if (!both.has(r.source)) continue;
      const pv = mPrev.get(ref);
      if (!pv) newN++;
      else if (r.p && pv.p && r.p < pv.p) { cuts.push((pv.p - r.p) / pv.p * 100); cutRows.push({ eid: e.id, name: e.name, r, from: pv.p, to: r.p, pct: (pv.p - r.p) / pv.p * 100 }); }
    }
    for (const [ref, r] of mPrev) if (both.has(r.source) && !mNow.has(ref)) removed++;
    const refsNow = new Set(mNow.keys());
    const cutRatio = refsNow.size ? cuts.length / refsNow.size * 100 : 0;
    const sup = prevD ? pct(now.length, prev.length) : null;
    if (prefsUsable) { budgetNow += now.filter(prefOk).length; if (prevD) budgetPrev += prev.filter(prefOk).length; else budgetPrevOk = false; }
    const tx30 = txns.filter((t) => t.estate_id === e.id && (t.reg_date || "") >= addDays(wEnd, -30)).length;
    const trend4 = pct(aNow, aM4);
    const bp = +((gap ?? 0) >= 5) + +(cutRatio >= 5) + +((sup ?? 0) >= 5) + +((trend4 ?? 0) <= -1);
    const sp = +(gap != null && gap <= 1) + +(cutRatio < 2) + +((sup ?? 0) <= -5) + +((trend4 ?? 0) >= 1);
    const temp = bp - sp >= 2 ? "🥶" : sp - bp >= 2 ? "🔥" : "😐";
    cards.push({ eid: e.id, name: e.name, nNow: now.length, aNow, aPrev: prevD ? aPrev : null, tMed, gap,
      nCut: cuts.length, nTx: txw.length, nNew: newN, nRemoved: removed, temp, hasPrev: !!prevD,
      trend4: m4D ? trend4 : null, months: tx30 ? now.length / tx30 : null,
      activity: cuts.length + txw.length + newN + removed });
  }

  // 心儀樓盤＋有對應放盤嘅睇樓記錄：只出「本週有變動」嘅
  const nowListing = {};
  for (const r of listings) if (snap[r.estate_id] && r.d === snap[r.estate_id].nowD) nowListing[r.ref_no] = r;
  const prevRefs = new Set(listings.filter((r) => snap[r.estate_id] && r.d === snap[r.estate_id].prevD).map((r) => r.ref_no));
  const tracked = [];
  for (const f of favListings) {
    if (!snap[f.estate_id]?.nowD || !fresh.some((e) => e.id === f.estate_id)) continue;
    const r = nowListing[f.ref_no];
    tracked.push({ icon: "♥", eid: f.estate_id, ref: f.ref_no, r, wk: prevPrice[f.ref_no] ?? null,
      label: r ? [r.b, r.f, r.u].filter(Boolean).join(" ") : "" });
  }
  for (const v of viewings) {
    if (!snap[v.estate_id]?.nowD || !fresh.some((e) => e.id === v.estate_id)) continue;
    const refs = String(v.linked_ref_no).split(",").filter(Boolean);
    const ref = refs.find((x) => nowListing[x]) || refs[0];
    tracked.push({ icon: "📝", eid: v.estate_id, ref, r: nowListing[ref], wk: prevPrice[ref] ?? null,
      label: `${v.block ?? ""}座 ${v.floor ?? ""}樓 ${v.unit ?? ""}室` });
  }
  const moves = [];
  for (const t of tracked) {
    if (!t.r) { if (prevRefs.has(t.ref)) moves.push({ ...t, kind: "gone" }); continue; }   // 只計本週先下架（上週仲喺度）
    const ch = t.wk ? pct(t.r.p, t.wk) : null;
    if (ch != null && Math.abs(ch) >= 0.05) moves.push({ ...t, kind: "price", from: t.wk, to: t.r.p, ch });
  }

  const totTx = cards.reduce((s, c) => s + c.nTx, 0), totCut = cards.reduce((s, c) => s + c.nCut, 0), totNew = cards.reduce((s, c) => s + c.nNew, 0);
  const gapMed = median(cards.map((c) => c.gap).filter((g) => g != null));
  cards.sort((a, b) => b.activity - a.activity);
  // 📉 本週減價最大 Top 3（合偏好）
  const topCuts = cutRows.filter((x) => !prefsUsable || prefOk(x.r)).sort((a, b) => b.pct - a.pct).slice(0, 3)
    .map((x) => ({ eid: x.eid, name: x.name, label: [x.r.b, x.r.f, x.r.u].filter(Boolean).join(" "), from: x.from, to: x.to, pct: x.pct, size: x.r.s, beds: x.r.beds, url: x.r.url, source: x.r.source }));
  // 🏠 本週新錄得成交（近 90 日登記）逐宗，同該屋苑叫價呎價中位比
  const aNowBy = Object.fromEntries(cards.map((c) => [c.eid, c.aNow]));
  const wkTx = txns.filter((t) => (t.first_seen || "") >= wStart && (t.reg_date || "") >= txnFrom && fresh.some((e) => e.id === t.estate_id))
    .sort((a, b) => String(b.reg_date).localeCompare(String(a.reg_date)));
  const weekTxns = wkTx.slice(0, 8).map((t) => ({ eid: t.estate_id, name: name[t.estate_id], label: [t.b, t.f, t.u].filter(Boolean).join(" "), p: t.p, psf: t.psf, reg: t.reg_date,
    vs: t.psf && aNowBy[t.estate_id] ? (t.psf / aNowBy[t.estate_id] - 1) * 100 : null }));
  const budget = prefsUsable ? { now: budgetNow, delta: budgetPrevOk ? budgetNow - budgetPrev : null } : null;
  return { status: "ok", wStart, wEnd, cards, moves, topCuts, weekTxns, weekTxnTotal: wkTx.length, budget, stale,
    totals: { tx: totTx, cut: totCut, newN: totNew, gap: gapMed },
    todo: weeklyTodos({ viewings: inp.todoViewings, dismissed: inp.todoDismissed, linkMaxDays: inp.todoLinkMaxDays ?? 30, today: wEnd }),
    name };
}

// ── 3. 排版 ─────────────────────────────────────────────────────────────────
export const wan = (p) => (p ? (p >= 1e6 ? `$${(p / 1e4).toLocaleString("en-US", { maximumFractionDigits: 0 })}萬` : `$${(p / 1e4).toFixed(1)}萬`) : "-");
export const arrow = (v, goodDown = true) => {
  if (v == null) return '<span style="color:#7a8ca0">數據累積中</span>';
  if (Math.abs(v) < 0.05) return '<span style="color:#7a8ca0">持平</span>';
  const up = v > 0, bad = goodDown ? up : !up;
  return `<span style="color:${bad ? "#cf2020" : "#15803d"};font-weight:700">${up ? "▲" : "▼"}${Math.abs(v).toFixed(1)}%</span>`;
};
export const mdLabel = (d) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
export const TD = "padding:6px 0;border-top:1px solid #edf2f8";

// 本週有冇值得寄嘅更新（冇就唔寄，用戶 2026-10-25 決定）：新盤／減價／新成交／你睇過嘅盤有變動。
// 「待跟進」係提醒唔係更新——單單有待辦、市場冇動靜，都唔寄。
export const weeklyIsEmpty = (w) => !((w.totals?.newN || 0) + (w.totals?.cut || 0) + (w.totals?.tx || 0) + (w.moves?.length || 0));

export function weeklyHeadline(w) {
  const t = w.totals;
  return `你 ${w.cards.length} 個最愛屋苑本週：新盤 ${t.newN} 個、減價 ${t.cut} 個、新錄得成交 ${t.tx} 宗`
    + (t.gap != null ? `；叫價平均${t.gap >= 0 ? "高" : "低"}過成交 ${Math.abs(t.gap).toFixed(1)}%` : "") + "。"
    + (w.moves.length ? `你睇過嘅盤有 ${w.moves.length} 個有變動。` : "");
}
export const weeklySubject = (w) => `搵樓日記每週摘要（${mdLabel(w.wStart)}–${mdLabel(w.wEnd)}）：${w.totals.newN} 新盤・${w.totals.cut} 減價・${w.totals.tx} 成交`;

export const box = (title, rows) => `<h2 style="font-size:15px;margin:18px 0 6px">${title}</h2><div style="background:#fff;border:1px solid #dde8f3;border-radius:14px;padding:4px 14px"><table role="presentation" style="width:100%;border-collapse:collapse;font-size:13.5px;color:#22344a">${rows}</table></div>`;
const safeHref = (u) => (/^https:\/\//i.test(String(u || "")) ? esc(u) : "");
// 「值得留意」一行（每週摘要同每日 email 共用）。pick＝{ name, label, price, size, beds, reasons[], url, source }；
// 來源同「抵買雷達」(computeBargainRadar) 一樣，index.js 負責轉換。
export const pickRowHtml = (p, srcName = () => "") => `<tr><td style="${TD}">${esc(p.name)} ${esc(p.label)}<br><span style="color:#15803d;font-size:12.5px">${p.reasons.map(esc).join("・")}</span></td>`
  + `<td style="${TD};text-align:right;white-space:nowrap"><b>${wan(p.price)}</b><br><span style="color:#7a8ca0;font-size:12px">${Math.round(p.size || 0)}呎${p.beds != null ? `・${esc(p.beds)}房` : ""}</span>`
  + [{ url: p.url, source: p.source }, ...(p.also || [])].filter((l) => safeHref(l.url))
      .map((l) => `<br><a href="${safeHref(l.url)}" style="color:#1270ac;font-size:12px;text-decoration:none">${esc(srcName(l.source))} ↗</a>`).join("")
  + `</td></tr>`;

export function renderWeeklyHtml(w, { appUrl, unsubUrl, iconUrl, prefLabel = "", srcName = () => "" }) {
  const moveRow = (m) => {
    const nm = w.name[m.eid] || "";
    const txt = m.kind === "gone" ? '<span style="color:#cf2020;font-weight:700">已下架</span>' : `${wan(m.from)} → <b>${wan(m.to)}</b> ${arrow(m.ch)}`;
    return `<tr><td style="${TD}">${m.icon} ${esc(nm)} ${esc(m.label)}</td><td style="${TD};text-align:right;white-space:nowrap">${txt}</td></tr>`;
  };
  const link = (u, src) => (/^https:\/\//i.test(String(u || "")) ? ` <a href="${esc(u)}" style="color:#1270ac;font-size:12px;text-decoration:none">${esc(srcName(src))} ↗</a>` : "");
  const cutRow = (c) => `<tr><td style="${TD}">${esc(c.name)} ${esc(c.label)}<br><span style="color:#7a8ca0;font-size:12.5px">${Math.round(c.size || 0)}呎${c.beds != null ? `・${esc(c.beds)}房` : ""}${link(c.url, c.source)}</span></td>`
    + `<td style="${TD};text-align:right;white-space:nowrap">${wan(c.from)} → <b>${wan(c.to)}</b><br><span style="color:#15803d;font-weight:700">▼${c.pct.toFixed(1)}%</span></td></tr>`;
  const estRow = (c) => {
    const note = c.gap == null ? "" : c.gap >= 5 ? `叫價高過成交 ${c.gap.toFixed(1)}%，有講價空間` : c.gap <= 1 ? "叫價貼近成交，業主少讓步" : `叫價高過成交 ${c.gap.toFixed(1)}%`;
    const extra = c.trend4 != null ? `4 週呎價 ${arrow(c.trend4)}` : "";   // 去貨月數唔顯示（用戶決定）；c.months 仍然有計，之後要用隨時可以出
    return `<tr><td style="padding:8px 0;border-top:1px solid #edf2f8;vertical-align:top"><b>${esc(c.name)}</b> <span style="font-size:12px">${c.temp}</span><br><span style="color:#7a8ca0;font-size:12.5px">${esc(note)}</span>${extra ? `<br><span style="color:#4f647a;font-size:12.5px">${extra}</span>` : ""}</td>`
      + `<td style="padding:8px 0;border-top:1px solid #edf2f8;text-align:right;font-size:12.5px;line-height:1.6;white-space:nowrap">${c.aNow ? `$${Math.round(c.aNow).toLocaleString("en-US")}/呎 ${arrow(pct(c.aNow, c.aPrev))}` : "-"}<br>放盤 ${c.nNow}・減價 ${c.nCut}・成交 ${c.nTx}</td></tr>`;
  };
  const txRow = (t) => `<tr><td style="${TD}">${esc(t.name)} ${esc(t.label)}<br><span style="color:#7a8ca0;font-size:12.5px">成交 ${esc(t.reg || "-")}${t.psf ? `・$${Math.round(t.psf).toLocaleString("en-US")}/呎` : ""}</span></td>`
    + `<td style="${TD};text-align:right;white-space:nowrap"><b>${wan(t.p)}</b>${t.vs != null ? `<br><span style="font-size:12px;color:#4f647a">比叫價中位 ${t.vs >= 0 ? "高" : "低"} ${Math.abs(t.vs).toFixed(1)}%</span>` : ""}</td></tr>`;
  const TODO_MAX = 5;   // 用戶決定：最多列 5 條
  const todoRow = (t) => {
    const blk = t.block && t.block !== t.estate ? `${t.block}${/座$/.test(t.block) ? "" : "座"}` : "";
    const unitLabel = `${blk}${t.floor ? `${t.floor}${/[樓層]$/.test(t.floor) ? "" : "樓"}` : ""}${t.unit ? `${t.unit}${/[室號]$/.test(t.unit) ? "" : "室"}` : ""}`;
    const tags = [t.missing.length ? `欠 ${t.missing.join("、")}` : "", t.needLink ? "未對應放盤" : ""].filter(Boolean);
    return `<tr><td style="${TD}">${esc(t.estate)} ${esc(unitLabel)}<br><span style="color:#7a8ca0;font-size:12.5px">睇樓 ${esc(String(t.viewDate).slice(5, 10))}</span></td>`
      + `<td style="${TD};text-align:right"><span style="display:inline-block;background:#fff4e0;color:#b45309;border-radius:8px;padding:2px 8px;font-size:12px;font-weight:700">${esc(tags.join("・"))}</span></td></tr>`;
  };
  const todoBox = w.todo && w.todo.total
    ? `<h2 style="font-size:15px;margin:18px 0 6px">📝 有 ${w.todo.total} 個睇樓記錄等你跟進</h2>`
      + `<div style="background:#fff;border:1px solid #dde8f3;border-radius:14px;padding:4px 14px"><div style="font-size:12.5px;color:#4f647a;line-height:1.7;padding:8px 0 4px">資料未填齊或者未對應放盤嘅記錄，系統追蹤唔到佢哋嘅改價、下架同成交。補返就會自動追蹤。</div>`
      + `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:13.5px;color:#22344a">${w.todo.items.slice(0, TODO_MAX).map(todoRow).join("")}</table>`
      + `${w.todo.total > TODO_MAX ? `<div style="font-size:12.5px;color:#7a8ca0;padding:6px 0 4px;border-top:1px solid #edf2f8">另有 ${w.todo.total - TODO_MAX} 個，返 app 睇全部</div>` : ""}`
      + `<div style="text-align:center;padding:8px 0 10px;border-top:1px solid #edf2f8"><a href="${esc(appUrl)}" style="color:#1270ac;font-weight:700;text-decoration:none;font-size:13.5px">返 app 補資料 →</a></div></div>`
    : "";
  const budgetBox = w.budget ? `<div style="background:#fff;border:1px solid #dde8f3;border-radius:14px;padding:10px 14px;margin-top:12px;font-size:13.5px;color:#22344a">🎯 你預算內嘅盤（${esc(prefLabel)}）：<b>${w.budget.now} 個</b>${w.budget.delta != null ? `，較上週 ${w.budget.delta > 0 ? `<span style="color:#15803d;font-weight:700">+${w.budget.delta}</span>` : w.budget.delta < 0 ? `<span style="color:#cf2020;font-weight:700">${w.budget.delta}</span>` : "冇變"}` : ""}</div>` : "";
  return `<!doctype html><html lang="zh-HK"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>搵樓日記每週摘要</title>
<body style="margin:0;background:#eef6fd;font-family:-apple-system,'PingFang HK','Heiti TC',sans-serif;color:#0f1c2e">
<div style="max-width:560px;margin:0 auto;padding:18px 14px 30px">
 <table role="presentation" style="border-collapse:collapse;width:100%"><tr><td style="padding-right:10px;width:44px"><img src="${esc(iconUrl)}" width="44" height="44" alt="" style="border-radius:10px;display:block"></td><td>
  <div style="font-size:19px;font-weight:800">📊 每週摘要</div><div style="font-size:13px;color:#4f647a">${mdLabel(w.wStart)} 至 ${mdLabel(w.wEnd)}</div></td><td style="text-align:right;vertical-align:middle;padding-left:8px"><a href="${esc(appUrl)}" style="background:#1270ac;color:#fff;text-decoration:none;padding:7px 13px;border-radius:999px;font-weight:700;font-size:13px;white-space:nowrap;display:inline-block">打開 app →</a></td></tr></table>
 <div style="background:#1270ac;color:#fff;border-radius:14px;padding:12px 16px;margin:12px 0 4px;font-size:14px;line-height:1.7">${esc(weeklyHeadline(w))}</div>
 ${w.moves.length ? box("❤️ 你睇過嘅盤", w.moves.map(moveRow).join("")) : ""}
 ${todoBox}
 ${w.topCuts.length ? box("📉 本週減價最大", w.topCuts.map(cutRow).join("")) : ""}
 ${budgetBox}
 ${box("🏢 屋苑市況", w.cards.map(estRow).join(""))}
 ${w.weekTxns.length ? box(`🏠 本週新錄得成交${w.weekTxnTotal > w.weekTxns.length ? `（共 ${w.weekTxnTotal} 宗，列最近 ${w.weekTxns.length} 宗）` : ""}`, w.weekTxns.map(txRow).join("")) : ""}
 <div style="text-align:center;margin:28px 0 38px"><a href="${esc(appUrl)}" style="background:#1270ac;color:#fff;text-decoration:none;padding:11px 22px;border-radius:999px;font-weight:700">打開搵樓日記睇詳情 →</a></div>
 <div style="font-size:11.5px;color:#7a8ca0;text-align:center;line-height:1.7">只計你喺搵樓日記標咗 ⭐ 最愛嘅屋苑。叫價以實用呎價中位數計；成交對比用近 90 日已登記成交。${w.stale.length ? `<br>${esc(w.stale.join("、"))} 嘅放盤數據未更新，今次未計入。` : ""}<br>
 唔想收每週摘要？<a href="${esc(unsubUrl)}" style="color:#7a8ca0">撳呢度取消</a>，或者喺 ⚙️ 設定熄咗「每週摘要」。</div>
</div></body></html>`;
}
