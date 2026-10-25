// 收費版生命週期 email（用戶 2026-10-26 要求：到期要有通知）。三封：
//   expiredEmail       — 收費版已到期／已取消，帳戶轉咗返免費版（一次）
//   （「即將到期」提醒 2026-10-26 用戶決定唔做，已拿走）
//   paymentFailedEmail — Stripe 扣款失敗（每張 invoice 一次）
// 純排版，冇 I/O；動態字串一律 esc()。性質係帳戶／帳單通知，所以唔跟每日 email 嘅退訂開關。
import { esc } from "./weekly.js";

const fmtDate = (d) => (/^\d{4}-\d{2}-\d{2}/.test(String(d || "")) ? `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日` : "");

const shell = ({ iconUrl, title, introHtml, sectionsHtml, ctaLabel, appUrl }) => `<!doctype html><html lang="zh-HK"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<body style="margin:0;background:#eef6fd;font-family:-apple-system,'PingFang HK','Heiti TC',sans-serif;color:#0f1c2e">
<div style="max-width:560px;margin:0 auto;padding:18px 14px 30px">
 <table role="presentation" style="border-collapse:collapse;width:100%"><tr><td style="padding-right:10px;width:44px"><img src="${esc(iconUrl)}" width="44" height="44" alt="" style="border-radius:10px;display:block"></td><td>
  <div style="font-size:19px;font-weight:800">${esc(title)}</div><div style="font-size:13px;color:#4f647a">搵樓日記</div></td></tr></table>
 <div style="background:#fff;border:1px solid #dde8f3;border-radius:14px;padding:16px 18px;margin:14px 0 4px;font-size:14.5px;line-height:1.8;color:#22344a">${introHtml}</div>
 ${sectionsHtml}
 <div style="text-align:center;margin:26px 0 24px"><a href="${esc(appUrl)}" style="background:#1270ac;color:#fff;text-decoration:none;padding:12px 26px;border-radius:999px;font-weight:700;display:inline-block">${esc(ctaLabel)}</a></div>
 <div style="font-size:11.5px;color:#7a8ca0;text-align:center;line-height:1.7">呢封係帳戶通知，唔係推廣 email。有問題可以喺 app 右上角「💬 意見回饋」話我知。</div>
</div></body></html>`;

const box = (title, itemsHtml) => `<h2 style="font-size:15px;margin:18px 0 6px">${title}</h2><div style="background:#fff;border:1px solid #dde8f3;border-radius:14px;padding:10px 18px;font-size:13.5px;line-height:1.85;color:#22344a">${itemsHtml}</div>`;
const li = (t) => `<div style="padding:3px 0">• ${t}</div>`;

// 免費版會鎖住啲咩（兩封信共用，同升級對比表一致）
const lockedList = (cap) => [
  `追蹤屋苑上限 <b>${cap} 個</b>`,
  "每日 email、每週摘要",
  "放盤日數、改價歷史、呎價走勢圖、歷史動態、本週動態",
  "睇樓分析（相對市價、成交對比）、對應放盤相片自動存檔",
  "恒生估值（免費版每個盤可以手動查一次）",
].map(li).join("");

export function expiredSubject({ reason }) { return reason === "canceled" ? "你嘅搵樓日記收費版已經結束" : "你嘅搵樓日記收費版已經到期"; }
export function expiredEmail({ appUrl, iconUrl, reason = "expired", periodEnd = "", cap = 3, pausedCount = 0 }) {
  const when = fmtDate(periodEnd);
  const intro = reason === "canceled"
    ? `多謝你一路支持搵樓日記。你嘅訂閱已經取消，<b>收費版已經結束</b>，帳戶轉返免費版。`
    : `多謝你一路支持搵樓日記。你嘅收費版${when ? `喺 <b>${esc(when)}</b> ` : ""}<b>已經到期</b>，帳戶轉返免費版。`;
  const keep = `<div style="margin-top:8px"><b>你嘅資料全部保留</b>：睇樓記錄、心儀樓盤、朋友屋企、偏好設定唔會刪。${pausedCount > 0
    ? `<br>免費版最多追蹤 ${cap} 個屋苑，所以有 <b>${pausedCount} 個屋苑暫停咗追蹤</b>（歷史資料保留，重新訂閱即刻恢復）。` : ""}</div>`;
  return shell({ iconUrl, appUrl, title: reason === "canceled" ? "收費版已結束" : "收費版已到期", introHtml: intro + keep,
    sectionsHtml: box("免費版會有啲功能鎖住", lockedList(cap)) + `<div style="font-size:13px;color:#4f647a;margin-top:12px;line-height:1.8">想繼續用返？喺 app 右上角「免費版 ⭐」可以重新訂閱，資料即時恢復。</div>`,
    ctaLabel: "返去搵樓日記" });
}

export const paymentFailedSubject = () => "搵樓日記：今次扣款唔成功，請檢查付款方式";
export function paymentFailedEmail({ appUrl, iconUrl, amount = "", nextTry = "" }) {
  const intro = `我哋喺收取你嘅收費版費用${amount ? `（<b>${esc(amount)}</b>）` : ""}時，扣款唔成功。`
    + (nextTry ? `支付系統會喺 <b>${esc(fmtDate(nextTry))}</b> 自動再試一次。` : "支付系統暫時唔會再自動重試。");
  const items = [
    "收費功能暫時照用，唔會即刻鎖住",
    "<b>每日 email 會暫停</b>，直到扣款成功",
    "如果多次都扣唔到，帳戶最終會轉返免費版",
  ].map(li).join("");
  return shell({ iconUrl, appUrl, title: "扣款唔成功", introHtml: intro,
    sectionsHtml: box("而家會點", items) + `<div style="font-size:13px;color:#4f647a;margin-top:12px;line-height:1.8">常見原因：卡過期、額度唔夠、銀行擋咗網上扣款。喺 app ⚙️ 設定 →「管理訂閱／發票」可以更新付款方式。</div>`,
    ctaLabel: "更新付款方式" });
}
