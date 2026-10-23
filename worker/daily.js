// 每日 email 新版排版（v2，淺色，同每週摘要同一套）。
// 同舊版 buildEmailHtml 嘅分別（用戶 2026-10-23 決定／建議）：
//   - 「💎 筍盤」改做「✨ 值得留意」（同每週摘要同一套邏輯，見 weekly.js）
//   - 你睇過／心儀嘅盤（變價、下架、單位成交）擺最頂，一行一個
//   - 每屋苑：新成交、新放盤各最多 DAILY_LIST_CAP 行，多出嚟寫「另有 N 個」
//   - 售價變動：跌／升幅 < DAILY_MIN_MOVE_PCT 唔逐條列（只計入數目）
//   - 已下架（唔係你睇過嘅）：淨係報數目，唔逐條列
//   - 租盤：每屋苑一行數目，詳情返 app 睇
// ⚠️ 兩個數字參數而家寫死喺度（預覽用）；正式切換前要搬入 CONFIG_DEFS（⚙️ 設定可改＋有說明）。
import { esc, wan, arrow, TD, box, pickRowHtml } from "./weekly.js";

export const DAILY_LIST_CAP = 5;
export const DAILY_MIN_MOVE_PCT = 3;

const safeHref = (u) => (/^https:\/\//i.test(String(u || "")) ? esc(u) : "");
const rent = (p) => (p ? `$${Math.round(p).toLocaleString("en-US")}/月` : "-");
const pctChg = (n, o) => (o ? (n / o - 1) * 100 : null);
const lab = (...a) => esc(a.filter(Boolean).join(" "));
const link = (u, text) => (safeHref(u) ? ` <a href="${safeHref(u)}" style="color:#1270ac;font-size:12px;text-decoration:none">${esc(text)} ↗</a>` : "");
const sizePsf = (size, psf) => [size ? `${Math.round(size)}呎` : null, psf ? `$${Math.round(psf).toLocaleString("en-US")}/呎` : null].filter(Boolean).join("・");
const row = (left, right, sub = "") =>
  `<tr><td style="${TD}">${left}${sub ? `<br><span style="color:#7a8ca0;font-size:12.5px">${sub}</span>` : ""}</td><td style="${TD};text-align:right;white-space:nowrap">${right}</td></tr>`;
const head = (text) => `<tr><td colspan="2" style="padding:10px 0 2px;font-weight:700;font-size:13px;color:#4f647a">${text}</td></tr>`;
const more = (n) => (n > 0 ? `<tr><td colspan="2" style="padding:6px 0;border-top:1px solid #edf2f8;color:#7a8ca0;font-size:12.5px">另有 ${n} 個，返 app 睇全部</td></tr>` : "");

export function dailyCounts(h) {
  const sum = (arr, k) => (arr || []).reduce((s, e) => s + (e[k]?.length || 0), 0);
  return {
    tx: sum(h.byEstate, "newTransactions"), price: sum(h.byEstate, "priceChanges"),
    newN: sum(h.byEstate, "newListings"), removed: sum(h.byEstate, "removedListings"),
    rent: sum(h.byEstateRent, "newRentTransactions") + sum(h.byEstateRent, "rentPriceChanges") + sum(h.byEstateRent, "newRentals") + sum(h.byEstateRent, "removedRentals"),
    watched: (h.linkedPriceChanges || []).length + (h.linkedRemoved || []).length + (h.allViewedTxns || []).length
      + (h.linkedRentPriceChanges || []).length + (h.linkedRentRemoved || []).length + (h.allViewedRentTxns || []).length,
  };
}

export function dailyHeadline(h) {
  const c = dailyCounts(h);
  const parts = [];
  if (c.watched) parts.push(`你留意緊嘅盤有 ${c.watched} 個變動`);
  if (c.newN) parts.push(`${c.newN} 個新放盤`);
  if (c.price) parts.push(`${c.price} 個變價`);
  if (c.tx) parts.push(`${c.tx} 宗新成交`);
  if (c.removed) parts.push(`${c.removed} 個下架`);
  if (c.rent) parts.push(`${c.rent} 個租盤動態`);
  return parts.length ? `今日：${parts.join("、")}。` : "今日你追蹤嘅屋苑冇新動態。";
}
export const dailySubject = (h, nPicks) => {
  const c = dailyCounts(h);
  const parts = [];
  if (c.watched) parts.push(`${c.watched} 個留意緊嘅盤有變動`);
  if (c.newN) parts.push(`${c.newN} 新放盤`);
  if (c.price) parts.push(`${c.price} 變價`);
  if (c.tx) parts.push(`${c.tx} 新成交`);
  if (nPicks) parts.push(`${nPicks} 個值得留意`);
  return parts.length ? `搵樓日記通知：${parts.join("・")}` : "搵樓日記通知：今日無更新";
};

// srcName：source id → 網站名（中原／美聯／香港置業／利嘉閣），由 index.js 用 SOURCES registry 傳入
export function renderDailyHtml(h, picks, { appUrl, unsubUrl, iconUrl, name = {}, prefLabel = "", srcName = () => "原網站" }) {
  const watched = [];
  for (const c of h.linkedPriceChanges || []) {
    const ch = pctChg(c.new_price, c.old_price);
    watched.push(row(`🏷️ ${lab(c.estate_name, c.building_name, c.floor, c.l_unit)}`,
      `${wan(c.old_price)} → <b>${wan(c.new_price)}</b> ${arrow(ch)}`,
      `${esc(sizePsf(c.size_net, c.price_per_ft))}${c.view_price ? `・睇樓價 ${wan(c.view_price)}` : ""}${link(c.detail_url, srcName(c.source))}`));
  }
  for (const c of h.linkedRemoved || []) {
    watched.push(row(`🚫 ${lab(c.estate_name, c.building_name, c.floor, c.l_unit)}`, '<span style="color:#cf2020;font-weight:700">已下架</span>',
      `${wan(c.price)}${c.view_date ? `・睇樓 ${esc(c.view_date)}` : ""}`));
  }
  for (const v of h.allViewedTxns || []) {
    const d = v.view_price && v.txn_price ? pctChg(v.txn_price, v.view_price) : null;
    watched.push(row(`👀 ${lab(v.estate_name, v.building, v.floor, v.unit)}`, `成交 <b>${wan(v.txn_price)}</b>${d != null ? ` ${arrow(d)}` : ""}`,
      `${esc(sizePsf(v.size_net, v.price_per_ft))}${v.view_price ? `・睇樓價 ${wan(v.view_price)}` : ""}`));
  }
  for (const c of h.linkedRentPriceChanges || []) {
    watched.push(row(`🔑 ${lab(c.estate_name, c.building_name, c.floor, c.l_unit)}`, `${rent(c.old_price)} → <b>${rent(c.new_price)}</b> ${arrow(pctChg(c.new_price, c.old_price))}`));
  }
  for (const c of h.linkedRentRemoved || []) {
    watched.push(row(`🔑 ${lab(c.estate_name, c.building_name, c.floor, c.l_unit)}`, '<span style="color:#cf2020;font-weight:700">租盤已下架</span>', rent(c.price)));
  }
  for (const v of h.allViewedRentTxns || []) {
    watched.push(row(`🔑👀 ${lab(v.estate_name, v.building, v.floor, v.unit)}`, `租務成交 <b>${rent(v.txn_price)}</b>`));
  }

  const estates = [];
  for (const e of h.byEstate || []) {
    const tx = e.newTransactions || [], pc = e.priceChanges || [], nl = e.newListings || [], rm = e.removedListings || [];
    if (!tx.length && !pc.length && !nl.length && !rm.length) continue;
    let rows = "";
    if (tx.length) {
      rows += head(`🏠 新成交 (${tx.length})`);
      for (const t of tx.slice(0, DAILY_LIST_CAP)) {
        const yrs = t.held_days ? t.held_days / 365 : null;
        const gainTxt = t.gain_pct != null
          ? `<span style="color:${t.gain_pct >= 0 ? "#15803d" : "#cf2020"};font-weight:700">${t.gain_pct >= 0 ? "▲" : "▼"}${Math.abs(t.gain_pct).toFixed(1)}%</span>`
          : "";
        rows += row(lab(t.building, t.floor, t.unit), `<b>${wan(t.price)}</b>${gainTxt ? ` ${gainTxt}` : ""}`,
          `${esc(sizePsf(t.size_net, t.price_per_ft))}・成交 ${esc(t.reg_date || "-")}${yrs ? `・持有 ${yrs.toFixed(1)} 年` : ""}`);
      }
      rows += more(tx.length - DAILY_LIST_CAP);
    }
    const big = pc.filter((l) => Math.abs(pctChg(l.new_price, l.old_price) ?? 0) >= DAILY_MIN_MOVE_PCT);
    if (pc.length) {
      rows += head(`💰 售價變動 (${pc.length})`);
      for (const l of big.slice(0, DAILY_LIST_CAP)) {
        rows += row(lab(l.building_name, l.floor, l.unit), `${wan(l.old_price)} → <b>${wan(l.new_price)}</b> ${arrow(pctChg(l.new_price, l.old_price))}`,
          `${esc(sizePsf(l.size_net, l.price_per_ft))}${link(l.detail_url, srcName(l.source))}`);
      }
      const hidden = pc.length - Math.min(big.length, DAILY_LIST_CAP);
      if (hidden > 0) rows += `<tr><td colspan="2" style="padding:6px 0;border-top:1px solid #edf2f8;color:#7a8ca0;font-size:12.5px">另有 ${hidden} 個細幅變價（${DAILY_MIN_MOVE_PCT}% 以下）</td></tr>`;
    }
    if (nl.length) {
      rows += head(`🆕 新放盤 (${nl.length})`);
      for (const l of nl.slice(0, DAILY_LIST_CAP)) {
        rows += row(lab(l.building_name, l.floor, l.unit), `<b>${wan(l.price)}</b>`,
          `${l.bedrooms ?? "-"}房・${esc(sizePsf(l.size_net, l.price_per_ft))}${link(l.detail_url, srcName(l.source))}`);
      }
      rows += more(nl.length - DAILY_LIST_CAP);
    }
    if (rm.length) rows += `<tr><td colspan="2" style="padding:8px 0 4px;border-top:1px solid #edf2f8;color:#7a8ca0;font-size:12.5px">❌ ${rm.length} 個盤下架</td></tr>`;
    estates.push(box(esc(e.estate), rows));
  }

  const rentLines = (h.byEstateRent || []).map((e) => {
    const parts = [[e.newRentals?.length, "新租盤"], [e.rentPriceChanges?.length, "變價"], [e.newRentTransactions?.length, "租務成交"], [e.removedRentals?.length, "下架"]]
      .filter(([n]) => n).map(([n, t]) => `${t} ${n}`);
    return parts.length ? row(esc(e.estate), esc(parts.join("・"))) : "";
  }).join("");

  return `<!doctype html><html lang="zh-HK"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>搵樓日記每日通知</title>
<body style="margin:0;background:#eef6fd;font-family:-apple-system,'PingFang HK','Heiti TC',sans-serif;color:#0f1c2e">
<div style="max-width:560px;margin:0 auto;padding:18px 14px 30px">
 <table role="presentation" style="border-collapse:collapse"><tr><td style="padding-right:10px"><img src="${esc(iconUrl)}" width="44" height="44" alt="" style="border-radius:10px;display:block"></td><td>
  <div style="font-size:19px;font-weight:800">🏙️ 每日通知</div><div style="font-size:13px;color:#4f647a">${esc(h.date || "")}</div></td></tr></table>
 <div style="background:#1270ac;color:#fff;border-radius:14px;padding:12px 16px;margin:12px 0 4px;font-size:14px;line-height:1.7">${esc(dailyHeadline(h))}</div>
 ${watched.length ? box("❤️ 你留意緊嘅盤", watched.join("")) : ""}
 ${picks.length ? box(`✨ 值得留意 <span style="font-weight:400;font-size:12px;color:#4f647a">（${esc(prefLabel)}）</span>`, picks.map((p) => pickRowHtml(name[p.eid], p)).join("")) : ""}
 ${estates.join("")}
 ${rentLines ? box("🔑 租盤動態", rentLines) : ""}
 <div style="text-align:center;margin:22px 0 8px"><a href="${esc(appUrl)}" style="background:#1270ac;color:#fff;text-decoration:none;padding:11px 22px;border-radius:999px;font-weight:700">打開搵樓日記睇詳情 →</a></div>
 <div style="font-size:11.5px;color:#7a8ca0;text-align:center;line-height:1.7">「值得留意」：合你睇樓偏好，而且自上次更新後有新放盤或者減價，同時呎價低過屋苑近 90 日成交中位數（或者放咗好耐再減價）。粗略基準，睇盤前自己覆核。<br>
 唔想收每日 email？<a href="${esc(unsubUrl)}" style="color:#7a8ca0">撳呢度取消訂閱</a>，或者喺 ⚙️ 設定關閉。</div>
</div></body></html>`;
}
