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
export async function computeEstateStats(db, estateId) {
  const id = Number(estateId);
  const now = (await db.prepare(
    `SELECT ${SNAP_COLS} FROM listings l WHERE l.estate_id = ?1 AND l.price > 0
     AND l.snapshot_date = (SELECT MAX(snapshot_date) FROM listings WHERE estate_id = ?1 AND source = l.source)`).bind(id).all()).results;
  const prev = (await db.prepare(
    `SELECT ${SNAP_COLS} FROM listings l WHERE l.estate_id = ?1 AND l.price > 0
     AND l.snapshot_date = (SELECT MAX(snapshot_date) FROM listings WHERE estate_id = ?1 AND source = l.source
       AND snapshot_date <= date((SELECT MAX(snapshot_date) FROM listings WHERE estate_id = ?1 AND source = l.source), '-7 days'))`).bind(id).all()).results;
  const txPsf = (await db.prepare(
    `SELECT price_per_ft AS psf FROM transactions WHERE estate_id = ? AND price_per_ft > 0 AND reg_date >= date('now', '+8 hours', '-3 months')`)
    .bind(id).all()).results.map((r) => r.psf);
  return statsFromSnapshots({ now, prev, txPsf });
}

// 有新 snapshot 嘅屋苑先重算（as_of 落後最新 snapshot）。limit 控制一次 invocation 嘅工作量。
export async function refreshEstateStats(db, { limit = 6 } = {}) {
  await ensureEstateStats(db);
  const { results } = await db.prepare(
    `SELECT e.id, st.as_of, (SELECT MAX(snapshot_date) FROM listings l WHERE l.estate_id = e.id) AS lmax
     FROM estates e LEFT JOIN estate_stats st ON st.estate_id = e.id
     WHERE (e.is_disabled = 0 OR e.is_disabled IS NULL)
       AND EXISTS (SELECT 1 FROM account_estates ae WHERE ae.estate_id = e.id AND ae.paused_at IS NULL)`).all();
  const due = results.filter((r) => r.lmax && (!r.as_of || r.lmax > r.as_of)).slice(0, limit);
  let done = 0;
  for (const r of due) {
    const st = await computeEstateStats(db, r.id);
    if (!st) continue;
    await db.prepare(
      `INSERT INTO estate_stats (estate_id, as_of, data, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(estate_id) DO UPDATE SET as_of = excluded.as_of, data = excluded.data, updated_at = excluded.updated_at`)
      .bind(r.id, st.as_of, JSON.stringify(st)).run();
    done++;
  }
  return { due: results.filter((r) => r.lmax && (!r.as_of || r.lmax > r.as_of)).length, done };
}
