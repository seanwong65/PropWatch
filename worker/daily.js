// 每日 email 新版排版（v2，淺色，同每週摘要同一套）。
// 同舊版 buildEmailHtml 嘅分別（用戶 2026-10-23 決定／建議）：
//   - 「💎 筍盤」改做「✨ 值得留意」（同每週摘要共用，數據仍然係抵買雷達 computeBargainRadar，只計最愛屋苑）
//   - 你睇過／心儀嘅盤（變價、下架、單位成交）擺最頂，一行一個
//   - 每屋苑：新成交、新放盤各最多 listCap 行，多出嚟寫「另有 N 個」
//   - 售價變動：跌／升幅 < minMovePct 唔逐條列（只計入數目）
//   - 已下架（唔係你睇過嘅）：淨係報數目，唔逐條列
//   - 租盤：同買盤一樣逐項列（新租盤、租金變動、租務成交、下架數目）
// 兩個數字（每項最多幾行、變價逐條列門檻）係 per-account ⚙️ 設定（email_list_cap／email_min_move_pct），
// 由 index.js 嘅 buildDailyEmail 傳入 listCap／minMovePct。
import { esc, wan, arrow, TD, box, pickRowHtml } from "./weekly.js";


const safeHref = (u) => (/^https:\/\//i.test(String(u || "")) ? esc(u) : "");
const rent = (p) => (p ? `$${Math.round(p).toLocaleString("en-US")}/月` : "-");
const pctChg = (n, o) => (o ? (n / o - 1) * 100 : null);
const lab = (...a) => esc(a.filter(Boolean).join(" "));
const link = (u, text) => (safeHref(u) ? ` <a href="${safeHref(u)}" style="color:#1270ac;font-size:12px;text-decoration:none">${esc(text)} ↗</a>` : "");
const sizePsf = (size, psf) => [size ? `${Math.round(size)}呎` : null, psf ? `$${Math.round(psf).toLocaleString("en-US")}/呎` : null].filter(Boolean).join("・");
const row = (left, right, sub = "", full = "") =>
  `<tr><td style="${TD}">${left}${sub ? `<br><span style="color:#7a8ca0;font-size:12.5px">${sub}</span>` : ""}</td><td style="${TD};text-align:right;white-space:nowrap">${right}</td></tr>`
  + (full ? `<tr><td colspan="2" style="padding:0 0 8px">${full}</td></tr>` : "");
// 改價記錄：每個價位一粒小標籤，跌綠升紅（segs＝getTodayHighlights 嘅 history：[{start,end,price,prev}]）
const histPills = (segs, fmtFn) => {
  if (!segs || segs.length < 2) return "";
  const pills = segs.map((s, i) => {
    const col = i === 0 ? "#4f647a" : s.price <= s.prev ? "#15803d" : "#cf2020";
    const mark = i === 0 ? "" : s.price <= s.prev ? "▼" : "▲";
    const last = i === segs.length - 1;
    return `<span style="display:inline-block;background:${last ? "#e4eefa" : "#f3f7fb"};border-radius:8px;padding:2px 7px;margin:2px 0;font-size:12px;color:${col};white-space:nowrap"><span style="color:#7a8ca0">${esc(String(s.start).slice(5))}</span> ${mark}${fmtFn(s.price)}</span>`;
  });
  return `<div style="line-height:1.9">${pills.join('<span style="color:#1270ac;font-size:15px;font-weight:700"> → </span>')}</div>`;
};
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

// 今日有冇值得寄嘅更新（冇就唔寄，用戶 2026-10-25 決定）。同 email 實際會列出嘅內容一致：
// 售價變動跌／升幅 < minMovePct 唔逐條列（只係「另有 N 個細幅變動」），所以單單細幅變動唔算更新；其餘各類有一項就算。
export function dailyIsEmpty(h, nPicks = 0, minMovePct = 3) {
  const c = dailyCounts(h);
  const bigPrice = (h.byEstate || []).reduce((s, e) => s + (e.priceChanges || []).filter((l) => Math.abs(pctChg(l.new_price, l.old_price) ?? 0) >= minMovePct).length, 0);
  return !(nPicks || c.watched || c.newN || c.tx || c.removed || c.rent || bigPrice);
}

export function dailyHeadline(h) {
  const c = dailyCounts(h);
  const parts = [];
  if (c.watched) parts.push(`你睇過嘅盤有 ${c.watched} 個變動`);
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
  if (c.watched) parts.push(`${c.watched} 個睇過嘅盤有變動`);
  if (c.newN) parts.push(`${c.newN} 新放盤`);
  if (c.price) parts.push(`${c.price} 變價`);
  if (c.tx) parts.push(`${c.tx} 新成交`);
  if (nPicks) parts.push(`${nPicks} 個值得留意`);
  return parts.length ? `搵樓日記通知：${parts.join("・")}` : "搵樓日記通知：今日無更新";
};

// srcName：source id → 網站名（中原／美聯／香港置業／利嘉閣），由 index.js 用 SOURCES registry 傳入
export function renderDailyHtml(h, picks, { appUrl, unsubUrl, iconUrl, prefLabel = "", srcName = () => "原網站", listCap = 5, minMovePct = 3 }) {
  const watched = [];
  for (const c of h.linkedPriceChanges || []) {
    const ch = pctChg(c.new_price, c.old_price);
    watched.push(row(`🏷️ ${lab(c.estate_name, c.building_name, c.floor, c.l_unit)}`,
      `${wan(c.old_price)} → <b>${wan(c.new_price)}</b> ${arrow(ch)}`,
      `${esc(sizePsf(c.size_net, c.price_per_ft))}${c.view_price ? `・睇樓價 ${wan(c.view_price)}` : ""}${link(c.detail_url, srcName(c.source))}`,
      histPills(c.history, wan)));
  }
  for (const c of h.linkedRemoved || []) {
    watched.push(row(`🚫 ${lab(c.estate_name, c.building_name, c.floor, c.l_unit)}`, '<span style="color:#cf2020;font-weight:700">已下架</span>',
      `${wan(c.price)}${c.view_date ? `・睇樓 ${esc(c.view_date)}` : ""}`, histPills(c.history, wan)));
  }
  for (const v of h.allViewedTxns || []) {
    const d = v.view_price && v.txn_price ? pctChg(v.txn_price, v.view_price) : null;
    watched.push(row(`👀 ${lab(v.estate_name, v.building, v.floor, v.unit)}`, `成交 <b>${wan(v.txn_price)}</b>${d != null ? ` ${arrow(d)}` : ""}`,
      `${esc(sizePsf(v.size_net, v.price_per_ft))}${v.view_price ? `・睇樓價 ${wan(v.view_price)}` : ""}`));
  }
  for (const c of h.linkedRentPriceChanges || []) {
    watched.push(row(`🔑 ${lab(c.estate_name, c.building_name, c.floor, c.l_unit)}`, `${rent(c.old_price)} → <b>${rent(c.new_price)}</b> ${arrow(pctChg(c.new_price, c.old_price))}`,
      `${esc(sizePsf(c.size_net, c.price_per_ft))}${link(c.detail_url, srcName(c.source))}`, histPills(c.history, rent)));
  }
  for (const c of h.linkedRentRemoved || []) {
    watched.push(row(`🔑 ${lab(c.estate_name, c.building_name, c.floor, c.l_unit)}`, '<span style="color:#cf2020;font-weight:700">租盤已下架</span>', rent(c.price), histPills(c.history, rent)));
  }
  for (const v of h.allViewedRentTxns || []) {
    watched.push(row(`🔑👀 ${lab(v.estate_name, v.building, v.floor, v.unit)}`, `租務成交 <b>${rent(v.txn_price)}</b>`));
  }

  // 一個屋苑（買或租）嘅動態：新成交、售價／租金變動、新放盤、下架（淨數目）。rentMode 只係換金額格式同標題 icon。
  const estateRows = ({ tx = [], pc = [], nl = [], rm = [] }, rentMode) => {
    if (!tx.length && !pc.length && !nl.length && !rm.length) return "";
    const money = rentMode ? rent : wan;
    let rows = "";
    if (tx.length) {
      rows += head(`🏠 ${rentMode ? "租務成交" : "新成交"} (${tx.length})`);
      for (const t of tx.slice(0, listCap)) {
        const yrs = t.held_days ? t.held_days / 365 : null;
        const gainTxt = t.gain_pct != null
          ? ` <span style="color:${t.gain_pct >= 0 ? "#15803d" : "#cf2020"};font-weight:700">${t.gain_pct >= 0 ? "▲" : "▼"}${Math.abs(t.gain_pct).toFixed(1)}%</span>` : "";
        rows += row(lab(t.building, t.floor, t.unit), `<b>${money(t.price)}</b>${gainTxt}`,
          `${esc(sizePsf(t.size_net, t.price_per_ft))}・${rentMode ? "租" : "成交"} ${esc(t.reg_date || "-")}${yrs ? `・持有 ${yrs.toFixed(1)} 年` : ""}`);
      }
      rows += more(tx.length - listCap);
    }
    const big = pc.filter((l) => Math.abs(pctChg(l.new_price, l.old_price) ?? 0) >= minMovePct);
    if (pc.length) {
      rows += head(`💰 ${rentMode ? "租金變動" : "售價變動"} (${pc.length})`);
      for (const l of big.slice(0, listCap)) {
        rows += row(lab(l.building_name, l.floor, l.unit), `${money(l.old_price)} → <b>${money(l.new_price)}</b> ${arrow(pctChg(l.new_price, l.old_price))}`,
          `${esc(sizePsf(l.size_net, l.price_per_ft))}${link(l.detail_url, srcName(l.source))}`);
      }
      const hidden = pc.length - Math.min(big.length, listCap);
      if (hidden > 0) rows += `<tr><td colspan="2" style="padding:6px 0;border-top:1px solid #edf2f8;color:#7a8ca0;font-size:12.5px">另有 ${hidden} 個細幅變動（${minMovePct}% 以下）</td></tr>`;
    }
    if (nl.length) {
      rows += head(`🆕 ${rentMode ? "新租盤" : "新放盤"} (${nl.length})`);
      for (const l of nl.slice(0, listCap)) {
        rows += row(lab(l.building_name, l.floor, l.unit), `<b>${money(l.price)}</b>`,
          `${l.bedrooms ?? "-"}房・${esc(sizePsf(l.size_net, l.price_per_ft))}${link(l.detail_url, srcName(l.source))}`);
      }
      rows += more(nl.length - listCap);
    }
    if (rm.length) rows += `<tr><td colspan="2" style="padding:8px 0 4px;border-top:1px solid #edf2f8;color:#7a8ca0;font-size:12.5px">❌ ${rm.length} 個${rentMode ? "租盤" : "盤"}下架</td></tr>`;
    return rows;
  };
  // 買盤、租盤各自包入一個大框，每個屋苑一個小標題
  const estateHead = (name) => `<tr><td colspan="2" style="padding:14px 0 2px;font-weight:700;font-size:14.5px;color:#0f1c2e;border-top:2px solid #dde8f3">${esc(name)}</td></tr>`;
  const saleRows = (h.byEstate || []).map((e) => {
    const rows = estateRows({ tx: e.newTransactions, pc: e.priceChanges, nl: e.newListings, rm: e.removedListings }, false);
    return rows ? estateHead(e.estate) + rows : "";
  }).join("");
  const rentRows = (h.byEstateRent || []).map((e) => {
    const rows = estateRows({ tx: e.newRentTransactions, pc: e.rentPriceChanges, nl: e.newRentals, rm: e.removedRentals }, true);
    return rows ? estateHead(e.estate) + rows : "";
  }).join("");

  return `<!doctype html><html lang="zh-HK"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>搵樓日記每日通知</title>
<body style="margin:0;background:#eef6fd;font-family:-apple-system,'PingFang HK','Heiti TC',sans-serif;color:#0f1c2e">
<div style="max-width:560px;margin:0 auto;padding:18px 14px 30px">
 <table role="presentation" style="border-collapse:collapse;width:100%"><tr><td style="padding-right:10px;width:44px"><img src="${esc(iconUrl)}" width="44" height="44" alt="" style="border-radius:10px;display:block"></td><td>
  <div style="font-size:19px;font-weight:800">🏙️ 每日通知</div><div style="font-size:13px;color:#4f647a">${esc(h.date || "")}</div></td><td style="text-align:right;vertical-align:middle;padding-left:8px"><a href="${esc(appUrl)}" style="background:#1270ac;color:#fff;text-decoration:none;padding:7px 13px;border-radius:999px;font-weight:700;font-size:13px;white-space:nowrap;display:inline-block">打開 app →</a></td></tr></table>
 <div style="background:#1270ac;color:#fff;border-radius:14px;padding:12px 16px;margin:12px 0 4px;font-size:14px;line-height:1.7">${esc(dailyHeadline(h))}</div>
 ${watched.length ? box("❤️ 你睇過嘅盤", watched.join("")) : ""}
 ${picks.length ? box(`✨ 值得留意 <span style="font-weight:400;font-size:12px;color:#4f647a">（${esc(prefLabel)}）</span>`, picks.map((p) => pickRowHtml(p, srcName)).join("")) : ""}
 ${saleRows ? box("🏢 買盤動態", saleRows) : ""}
 ${rentRows ? box("🔑 租盤動態", rentRows) : ""}
 <div style="text-align:center;margin:28px 0 38px"><a href="${esc(appUrl)}" style="background:#1270ac;color:#fff;text-decoration:none;padding:11px 22px;border-radius:999px;font-weight:700">打開搵樓日記睇詳情 →</a></div>
 <div style="font-size:11.5px;color:#7a8ca0;text-align:center;line-height:1.7">「值得留意」同 app 嘅抵買雷達一樣：你標咗 ⭐ 最愛嘅屋苑入面，合你睇樓偏好、呎價低過屋苑近期成交中位數最多嘅在售盤。係粗略基準，睇盤前自己覆核。<br>
 唔想收每日 email？<a href="${esc(unsubUrl)}" style="color:#7a8ca0">撳呢度取消訂閱</a>，或者喺 ⚙️ 設定關閉。</div>
</div></body></html>`;
}
