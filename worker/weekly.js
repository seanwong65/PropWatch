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
  const { results: dateRows } = await db.prepare(
    `SELECT estate_id, snapshot_date AS d FROM listings
     WHERE estate_id IN (${ids}) AND snapshot_date >= ? AND snapshot_date <= ?
     GROUP BY estate_id, snapshot_date`).bind(addDays(wEnd, -40), wEnd).all();
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
    `SELECT estate_id, snapshot_date AS d, ref_no, building_name AS b, floor AS f, unit AS u, bedrooms AS beds,
            size_net AS s, price AS p, price_per_ft AS psf
     FROM listings WHERE ${conds.join(" OR ")}`).all()).results : [];
  const prevWeek = addDays(wEnd, -7);
  const history = (await db.prepare(
    `SELECT estate_id, ref_no, price AS p, snapshot_date AS d FROM listing_price_history
     WHERE estate_id IN (${ids}) AND snapshot_date >= ? ORDER BY snapshot_date`).bind(prevWeek).all()).results;
  const first = {};
  for (const r of (await db.prepare(
    `SELECT ref_no, MIN(snapshot_date) AS fs FROM listing_price_history WHERE estate_id IN (${ids}) GROUP BY ref_no`).all()).results) first[r.ref_no] = r.fs;
  const txnFrom = addDays(wEnd, -90);
  const txns = (await db.prepare(
    `SELECT estate_id, building AS b, floor AS f, unit AS u, price AS p, size_net AS s, price_per_ft AS psf, reg_date, first_seen
     FROM transactions WHERE estate_id IN (${ids}) AND (reg_date >= ? OR first_seen >= ?)`).bind(txnFrom, wStart).all()).results;
  const favListings = (await db.prepare(
    `SELECT estate_id, ref_no FROM listing_favourites WHERE account_id = ? AND deal = 'S' AND estate_id IN (${ids})`).bind(accountId).all()).results;
  const viewings = (await db.prepare(
    `SELECT estate_id, view_date, block, floor, unit, size_net, linked_ref_no FROM viewings
     WHERE account_id = ? AND estate_id IN (${ids}) AND linked_ref_no IS NOT NULL AND linked_ref_no != ''
     ORDER BY view_date DESC LIMIT 40`).bind(accountId).all()).results;
  return { favourites: ests, wStart, wEnd, snap, listings, history, first, txns, txnFrom, favListings, viewings, prefs: prefs || {} };
}

// ── 2. 計算（純函數）─────────────────────────────────────────────────────────
export function computeWeekly(inp) {
  if (!inp.favourites.length) return { status: "skip", reason: "no_favourites" };
  const { wStart, wEnd, snap, listings, history, first, txns, txnFrom, favListings, viewings } = inp;
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
  const refsAt = (eid, d) => new Set(listings.filter((r) => r.estate_id === eid && r.d === d).map((r) => r.ref_no));
  const hist = {};
  for (const r of history) (hist[r.ref_no] ||= []).push(r);
  const priceCut = (ref) => { const h = hist[ref] || []; return h.length >= 2 && h[h.length - 1].p < h[0].p ? h : null; };

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
    const refsNow = refsAt(e.id, nowD), refsPrev = prevD ? refsAt(e.id, prevD) : new Set();
    const cuts = [...refsNow].map((ref) => { const h = priceCut(ref); return h ? (h[0].p - h[h.length - 1].p) / h[0].p * 100 : null; }).filter((x) => x != null);
    const newN = [...refsNow].filter((r) => (first[r] || "") >= wStart).length;
    const removed = [...refsPrev].filter((r) => !refsNow.has(r)).length;
    const cutRatio = refsNow.size ? cuts.length / refsNow.size * 100 : 0;
    const sup = prevD ? pct(now.length, prev.length) : null;
    const trend4 = pct(aNow, aM4);
    const bp = +((gap ?? 0) >= 5) + +(cutRatio >= 5) + +((sup ?? 0) >= 5) + +((trend4 ?? 0) <= -1);
    const sp = +(gap != null && gap <= 1) + +(cutRatio < 2) + +((sup ?? 0) <= -5) + +((trend4 ?? 0) >= 1);
    const temp = bp - sp >= 2 ? "🥶" : sp - bp >= 2 ? "🔥" : "😐";
    cards.push({ eid: e.id, name: e.name, nNow: now.length, aNow, aPrev: prevD ? aPrev : null, tMed, gap,
      nCut: cuts.length, nTx: txw.length, nNew: newN, nRemoved: removed, temp, hasPrev: !!prevD,
      activity: cuts.length + txw.length + newN + removed });
  }

  // 心儀樓盤＋有對應放盤嘅睇樓記錄：只出「本週有變動」嘅
  const nowListing = {};
  for (const r of listings) if (snap[r.estate_id] && r.d === snap[r.estate_id].nowD) nowListing[r.ref_no] = r;
  const prevRefs = new Set(listings.filter((r) => snap[r.estate_id] && r.d === snap[r.estate_id].prevD).map((r) => r.ref_no));
  const tracked = [];
  for (const f of favListings) {
    if (!snap[f.estate_id]?.nowD || !fresh.some((e) => e.id === f.estate_id)) continue;
    const r = nowListing[f.ref_no], h = hist[f.ref_no] || [];
    tracked.push({ icon: "♥", eid: f.estate_id, ref: f.ref_no, r, wk: h[0]?.p ?? null,
      label: r ? [r.b, r.f, r.u].filter(Boolean).join(" ") : "" });
  }
  for (const v of viewings) {
    if (!snap[v.estate_id]?.nowD || !fresh.some((e) => e.id === v.estate_id)) continue;
    const refs = String(v.linked_ref_no).split(",").filter(Boolean);
    const ref = refs.find((x) => nowListing[x]) || refs[0];
    const h = refs.map((x) => hist[x]).find(Boolean) || [];
    tracked.push({ icon: "📝", eid: v.estate_id, ref, r: nowListing[ref], wk: h[0]?.p ?? null,
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
  return { status: "ok", wStart, wEnd, cards, moves, stale,
    totals: { tx: totTx, cut: totCut, newN: totNew, gap: gapMed },
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

export function weeklyHeadline(w) {
  const t = w.totals;
  return `你 ${w.cards.length} 個最愛屋苑本週：新盤 ${t.newN} 個、減價 ${t.cut} 個、新錄得成交 ${t.tx} 宗`
    + (t.gap != null ? `；叫價平均${t.gap >= 0 ? "高" : "低"}過成交 ${Math.abs(t.gap).toFixed(1)}%` : "") + "。"
    + (w.moves.length ? `你留意緊嘅盤有 ${w.moves.length} 個有變動。` : "");
}
export const weeklySubject = (w) => `搵樓日記每週摘要（${mdLabel(w.wStart)}–${mdLabel(w.wEnd)}）：${w.totals.newN} 新盤・${w.totals.cut} 減價・${w.totals.tx} 成交`;

export const box = (title, rows) => `<h2 style="font-size:15px;margin:18px 0 6px">${title}</h2><div style="background:#fff;border:1px solid #dde8f3;border-radius:14px;padding:4px 14px"><table role="presentation" style="width:100%;border-collapse:collapse;font-size:13.5px;color:#22344a">${rows}</table></div>`;
const safeHref = (u) => (/^https:\/\//i.test(String(u || "")) ? esc(u) : "");
// 「值得留意」一行（每週摘要同每日 email 共用）。pick＝{ name, label, price, size, beds, reasons[], url, source }；
// 來源同「抵買雷達」(computeBargainRadar) 一樣，index.js 負責轉換。
export const pickRowHtml = (p, srcName = () => "") => `<tr><td style="${TD}">${esc(p.name)} ${esc(p.label)}<br><span style="color:#15803d;font-size:12.5px">${p.reasons.map(esc).join("・")}</span></td>`
  + `<td style="${TD};text-align:right;white-space:nowrap"><b>${wan(p.price)}</b><br><span style="color:#7a8ca0;font-size:12px">${Math.round(p.size || 0)}呎${p.beds != null ? `・${esc(p.beds)}房` : ""}</span>`
  + `${safeHref(p.url) ? `<br><a href="${safeHref(p.url)}" style="color:#1270ac;font-size:12px;text-decoration:none">${esc(srcName(p.source))} ↗</a>` : ""}</td></tr>`;

export function renderWeeklyHtml(w, { appUrl, unsubUrl, iconUrl, picks = [], prefLabel = "", srcName = () => "" }) {
  const moveRow = (m) => {
    const nm = w.name[m.eid] || "";
    const txt = m.kind === "gone" ? '<span style="color:#cf2020;font-weight:700">已下架</span>' : `${wan(m.from)} → <b>${wan(m.to)}</b> ${arrow(m.ch)}`;
    return `<tr><td style="${TD}">${m.icon} ${esc(nm)} ${esc(m.label)}</td><td style="${TD};text-align:right;white-space:nowrap">${txt}</td></tr>`;
  };
  const estRow = (c) => {
    const note = c.gap == null ? "" : c.gap >= 5 ? `叫價高過成交 ${c.gap.toFixed(1)}%，有講價空間` : c.gap <= 1 ? "叫價貼近成交，業主少讓步" : `叫價高過成交 ${c.gap.toFixed(1)}%`;
    return `<tr><td style="padding:8px 0;border-top:1px solid #edf2f8;vertical-align:top"><b>${esc(c.name)}</b> <span style="font-size:12px">${c.temp}</span><br><span style="color:#7a8ca0;font-size:12.5px">${esc(note)}</span></td>`
      + `<td style="padding:8px 0;border-top:1px solid #edf2f8;text-align:right;font-size:12.5px;line-height:1.6;white-space:nowrap">${c.aNow ? `$${Math.round(c.aNow).toLocaleString("en-US")}/呎 ${arrow(pct(c.aNow, c.aPrev))}` : "-"}<br>放盤 ${c.nNow}・減價 ${c.nCut}・成交 ${c.nTx}</td></tr>`;
  };
  return `<!doctype html><html lang="zh-HK"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>搵樓日記每週摘要</title>
<body style="margin:0;background:#eef6fd;font-family:-apple-system,'PingFang HK','Heiti TC',sans-serif;color:#0f1c2e">
<div style="max-width:560px;margin:0 auto;padding:18px 14px 30px">
 <table role="presentation" style="border-collapse:collapse"><tr><td style="padding-right:10px"><img src="${esc(iconUrl)}" width="44" height="44" alt="" style="border-radius:10px;display:block"></td><td>
  <div style="font-size:19px;font-weight:800">📊 每週摘要</div><div style="font-size:13px;color:#4f647a">${mdLabel(w.wStart)} 至 ${mdLabel(w.wEnd)}</div></td></tr></table>
 <div style="background:#1270ac;color:#fff;border-radius:14px;padding:12px 16px;margin:12px 0 4px;font-size:14px;line-height:1.7">${esc(weeklyHeadline(w))}</div>
 ${w.moves.length ? box("❤️ 你留意緊嘅盤：本週有變動", w.moves.map(moveRow).join("")) : ""}
 ${picks.length ? box(`✨ 值得留意 <span style="font-weight:400;font-size:12px;color:#4f647a">（${esc(prefLabel)}）</span>`, picks.map((p) => pickRowHtml(p, srcName)).join("")) : ""}
 ${box("🏢 最愛屋苑市況", w.cards.map(estRow).join(""))}
 <div style="text-align:center;margin:22px 0 8px"><a href="${esc(appUrl)}" style="background:#1270ac;color:#fff;text-decoration:none;padding:11px 22px;border-radius:999px;font-weight:700">打開搵樓日記睇詳情 →</a></div>
 <div style="font-size:11.5px;color:#7a8ca0;text-align:center;line-height:1.7">只計你喺搵樓日記標咗 ⭐ 最愛嘅屋苑。叫價以實用呎價中位數計；成交對比用近 90 日已登記成交。${w.stale.length ? `<br>${esc(w.stale.join("、"))} 嘅放盤數據未更新，今次未計入。` : ""}<br>
 唔想收每週摘要？<a href="${esc(unsubUrl)}" style="color:#7a8ca0">撳呢度取消</a>，或者喺 ⚙️ 設定熄咗「每週摘要」。</div>
</div></body></html>`;
}
