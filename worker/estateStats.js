// 屋苑卡片（側邊欄）嘅「重點數字」：每個屋苑每日一行，存喺 estate_stats，/api/estates 直接 join，
// 開 app 唔使逐次重算（之前教訓：側邊欄 query 一食 D1 讀取額度就好痛，見 NOTES「D1 額度」）。
// 全部由兩份 snapshot（最新 vs 約 7 日前）＋近 3 個月成交計，冇用 listing_price_history（成個表掃）。
// 唔使任何門檻參數（冇「市況溫度」呢類要揀 cutoff 嘅嘢）——只係事實數字。
const DAY = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);
const median = (xs) => {
  const a = xs.filter((x) => Number.isFinite(x) && x > 0).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const unitKey = (r) => `${r.b || ""}|${r.f || ""}|${r.u || r.ref_no}|${Math.round(r.s || 0)}`;
const uniqUnits = (rows) => { const m = new Map(); for (const r of rows) if (!m.has(unitKey(r))) m.set(unitKey(r), r); return [...m.values()]; };

// 純計算（有單元測試）。now／prev：[{source, d, ref_no, b, f, u, s, p, psf}]；txPsf：近 3 個月成交呎價。
export function statsFromSnapshots({ now, prev, txPsf = [] }) {
  const asOf = now.reduce((m, r) => (r.d > m ? r.d : m), "");
  if (!asOf) return null;
  const prevAsOf = prev.reduce((m, r) => (r.d > m ? r.d : m), "") || null;
  const uNow = uniqUnits(now), uPrev = uniqUnits(prev);
  const psf = median(uNow.map((r) => r.psf));
  const psfPrev = prev.length ? median(uPrev.map((r) => r.psf)) : null;
  // 新盤／下架／減價只比「兩份都有 snapshot 嘅 source」，否則新加入嘅 source 會令全部盤變新盤
  const both = new Set(now.map((r) => r.source).filter((s) => prev.some((x) => x.source === s)));
  const pn = new Map(now.filter((r) => both.has(r.source)).map((r) => [r.ref_no, r.p]));
  const pp = new Map(prev.filter((r) => both.has(r.source)).map((r) => [r.ref_no, r.p]));
  let nNew = 0, nRemoved = 0, nCuts = 0;
  for (const [ref, p] of pn) { if (!pp.has(ref)) nNew++; else if (p && pp.get(ref) && p < pp.get(ref)) nCuts++; }
  for (const ref of pp.keys()) if (!pn.has(ref)) nRemoved++;
  const txMed = txPsf.length >= 5 ? median(txPsf) : null;   // 成交少過 5 宗，中位數唔可信（同抵買雷達 market_min_sold 預設一致）
  const hasPrev = both.size > 0;
  return {
    as_of: asOf, prev_as_of: hasPrev ? prevAsOf : null, span_days: hasPrev && prevAsOf ? daysBetween(prevAsOf, asOf) : null,
    n: uNow.length, n_prev: hasPrev ? uPrev.length : null,
    psf: psf ? Math.round(psf) : null, psf_prev: hasPrev && psfPrev ? Math.round(psfPrev) : null,
    new: hasPrev ? nNew : null, removed: hasPrev ? nRemoved : null, cuts: hasPrev ? nCuts : null,
    tx_n: txPsf.length, tx_psf: txMed ? Math.round(txMed) : null,
    gap: psf && txMed ? Math.round((psf / txMed - 1) * 1000) / 10 : null,
  };
}

let _ready = false;
export async function ensureEstateStats(db) {
  if (_ready) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS estate_stats (estate_id INTEGER PRIMARY KEY, as_of TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  _ready = true;
}

const SNAP_COLS = "l.source, l.snapshot_date AS d, l.ref_no, l.building_name AS b, l.floor AS f, l.unit AS u, l.size_net AS s, l.price AS p, l.price_per_ft AS psf";
const isoDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
// ⚠️ 效能（2026-10-24 教訓）：唔好寫 `snapshot_date = (SELECT MAX(snapshot_date) ... WHERE source = l.source)` 呢種 correlated subquery
// ——SQLite 會逐行（屋苑全部歷史 snapshot ~1.5–3 萬行）計一次，一次重算食 ~2 萬 rows read；24 個屋苑一刷就過百萬。
// 改為：每個 source 用 scalar subquery 各 seek 一次 MAX（走 idx_listings_estate_src_date），再用「確實日期」攞嗰日嗰批 rows。
// `sources` 由 caller 傳入（index.js 嘅 SOURCES），做 SQL literal 前一定驗證係 [a-z]+。
// 攞「最新 vs 約 7 日前」兩份 snapshot（只攞兩個日子嘅 rows）。computeEstateStats（卡片數字）同 computeWeekChanges（本週變動面板）共用，
// 所以兩邊用同一套日子、同一個「兩邊都有 snapshot 嘅 source」邏輯，數字一定對得上。
export async function loadSnapshotPair(db, estateId, sources, cols = SNAP_COLS) {
  const id = Number(estateId);
  const srcs = sources.filter((x) => /^[a-z]+$/.test(x));
  const latestRow = await db.prepare(
    `SELECT ${srcs.map((x, i) => `(SELECT MAX(snapshot_date) FROM listings WHERE estate_id = ?1 AND source = '${x}') AS d${i}`).join(", ")}`).bind(id).first();
  const latest = srcs.map((x, i) => [x, latestRow?.[`d${i}`]]).filter(([, d]) => isoDate(d));
  if (!latest.length) return null;
  const prevRow = await db.prepare(
    `SELECT ${latest.map(([x], i) => `(SELECT MAX(snapshot_date) FROM listings WHERE estate_id = ?1 AND source = '${x}' AND snapshot_date <= ?${i + 2}) AS p${i}`).join(", ")}`)
    .bind(id, ...latest.map(([, d]) => addDays(d, -7))).first();
  const prevPairs = latest.map(([x], i) => [x, prevRow?.[`p${i}`]]).filter(([, d]) => isoDate(d));
  const rowsFor = async (pairs) => (!pairs.length ? [] : (await db.prepare(
    `SELECT ${cols} FROM listings l WHERE l.estate_id = ?1 AND l.price > 0
     AND (${pairs.map(([x, d]) => `(l.source = '${x}' AND l.snapshot_date = '${d}')`).join(" OR ")})`).bind(id).all()).results);
  return { now: await rowsFor(latest), prev: await rowsFor(prevPairs) };
}

export async function computeEstateStats(db, estateId, sources) {
  const id = Number(estateId);
  const pair = await loadSnapshotPair(db, id, sources);
  if (!pair) return null;
  const txPsf = (await db.prepare(
    `SELECT price_per_ft AS psf FROM transactions WHERE estate_id = ? AND price_per_ft > 0 AND reg_date >= date('now', '+8 hours', '-3 months')`)
    .bind(id).all()).results.map((r) => r.psf);
  return statsFromSnapshots({ now: pair.now, prev: pair.prev, txPsf });
}

// ── 本週變動面板（卡片「本週：新盤 N・減價 N・下架 N」撳入去睇逐個）──
// 純計算：新盤／減價／下架嘅判斷同 statsFromSnapshots 完全一樣（只比兩邊都有 snapshot 嘅 source、按 ref_no），所以條數一定同卡片一致。
// rows 要帶 source, ref_no, b, f, u, beds, s, p, psf, url, lid。每類最多列 cap 條（總數照回）。
const rowOut = (r) => ({ src: r.source, ref: r.ref_no, b: r.b || "", f: r.f || "", u: r.u || "", beds: r.beds ?? null, s: r.s || null, p: r.p, psf: r.psf || null, url: r.url || null, lid: r.lid || null });
export function weekChangesFromSnapshots({ now, prev, cap = 60 }) {
  const both = new Set(now.map((r) => r.source).filter((s) => prev.some((x) => x.source === s)));
  const nowRows = now.filter((r) => both.has(r.source)), prevRows = prev.filter((r) => both.has(r.source));
  const pn = new Map(nowRows.map((r) => [r.ref_no, r])), pp = new Map(prevRows.map((r) => [r.ref_no, r]));
  const added = [], cuts = [], removed = [];
  for (const [ref, r] of pn) {
    const o = pp.get(ref);
    if (!o) added.push(rowOut(r));
    else if (r.p && o.p && r.p < o.p) cuts.push({ ...rowOut(r), from: o.p, to: r.p, pct: Math.round((r.p / o.p - 1) * 1000) / 10 });
  }
  for (const [ref, r] of pp) if (!pn.has(ref)) removed.push(rowOut(r));
  added.sort((a, b) => a.p - b.p);
  cuts.sort((a, b) => a.pct - b.pct);          // 跌幅最大（最負）排先
  removed.sort((a, b) => a.p - b.p);
  return { hasPrev: both.size > 0, counts: { new: added.length, cuts: cuts.length, removed: removed.length },
    new: added.slice(0, cap), cuts: cuts.slice(0, cap), removed: removed.slice(0, cap), askMedian: median(uniqUnits(nowRows).map((r) => r.psf)) };
}

// 新成交：first_seen 喺 [asOf-6, asOf] 嘅成交（同每週摘要「本週新錄得成交」一致）；vs＝成交呎價對比而家叫價呎價中位。
export function weekTxnsFrom(txns, asOf, askMedian, cap = 60) {
  const from = addDays(asOf, -6);
  const rows = (txns || []).filter((t) => t.first_seen && t.first_seen >= from && t.first_seen <= asOf)
    .sort((a, b) => String(b.reg_date).localeCompare(String(a.reg_date)) || b.price - a.price);
  return { total: rows.length, items: rows.slice(0, cap).map((t) => ({
    b: t.building || "", f: t.floor || "", u: t.unit || "", p: t.price, s: t.size_net || null, psf: t.price_per_ft || null, reg: t.reg_date || null,
    vs: askMedian && t.price_per_ft ? Math.round((t.price_per_ft / askMedian - 1) * 1000) / 10 : null })) };
}

const EXT_COLS = `${SNAP_COLS}, l.listing_id AS lid, l.bedrooms AS beds, l.detail_url AS url`;
export async function computeWeekChanges(db, estateId, sources) {
  const id = Number(estateId);
  const pair = await loadSnapshotPair(db, id, sources, EXT_COLS);
  if (!pair) return null;
  const asOf = pair.now.reduce((m, r) => (r.d > m ? r.d : m), "");
  const prevAsOf = pair.prev.reduce((m, r) => (r.d > m ? r.d : m), "") || null;
  const w = weekChangesFromSnapshots(pair);
  if (!w.hasPrev) return { as_of: asOf, prev_as_of: null, unavailable: true };
  // 下架：上架咗幾多日（listing_span.first_seen → 最後出現日）
  const lids = [...new Set(w.removed.map((r) => r.lid).filter(Boolean))].slice(0, 60);
  const span = {};
  if (lids.length) {
    const { results } = await db.prepare(
      `SELECT listing_id, first_seen FROM listing_span WHERE estate_id = ? AND listing_id IN (${lids.map(() => "?").join(",")})`).bind(id, ...lids).all().catch(() => ({ results: [] }));
    for (const r of results) span[r.listing_id] = r.first_seen;
  }
  const lastSeen = prevAsOf;
  for (const r of w.removed) { const f = span[r.lid]; r.days = f && lastSeen ? daysBetween(f, lastSeen) : null; delete r.lid; }
  for (const k of ["new", "cuts"]) for (const r of w[k]) delete r.lid;
  const txns = (await db.prepare(
    `SELECT building, floor, unit, price, size_net, price_per_ft, reg_date, first_seen FROM transactions WHERE estate_id = ? AND reg_date >= ?`)
    .bind(id, addDays(asOf, -90)).all()).results;
  const t = weekTxnsFrom(txns, asOf, w.askMedian);
  return { as_of: asOf, prev_as_of: prevAsOf, span_days: prevAsOf ? daysBetween(prevAsOf, asOf) : null,
    counts: { ...w.counts, txns: t.total }, new: w.new, cuts: w.cuts, removed: w.removed, txns: t.items };
}

// 有新 snapshot 嘅屋苑先重算（as_of 落後最新 snapshot）。limit 控制一次 invocation 嘅工作量。
export async function refreshEstateStats(db, { limit = 6, sources = ["centanet", "midland", "hkp", "ricacorp"] } = {}) {
  await ensureEstateStats(db);
  const { results } = await db.prepare(
    `SELECT e.id, st.as_of, (SELECT MAX(snapshot_date) FROM listings l WHERE l.estate_id = e.id) AS lmax
     FROM estates e LEFT JOIN estate_stats st ON st.estate_id = e.id
     WHERE (e.is_disabled = 0 OR e.is_disabled IS NULL)
       AND EXISTS (SELECT 1 FROM account_estates ae WHERE ae.estate_id = e.id AND ae.paused_at IS NULL)`).all();
  const due = results.filter((r) => r.lmax && (!r.as_of || r.lmax > r.as_of)).slice(0, limit);
  let done = 0;
  for (const r of due) {
    const st = await computeEstateStats(db, r.id, sources);
    if (!st) continue;
    await db.prepare(
      `INSERT INTO estate_stats (estate_id, as_of, data, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(estate_id) DO UPDATE SET as_of = excluded.as_of, data = excluded.data, updated_at = excluded.updated_at`)
      .bind(r.id, st.as_of, JSON.stringify(st)).run();
    done++;
  }
  return { due: results.filter((r) => r.lmax && (!r.as_of || r.lmax > r.as_of)).length, done };
}
