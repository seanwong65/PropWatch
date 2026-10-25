import { describe, it, expect } from "vitest";
import { computeWeekly, renderWeeklyHtml, weeklyHeadline, weeklySubject, weeklyTodos, weeklyIsEmpty } from "../weekly.js";

// 2026-10-24（六）寄信；本週 = 10-18 ~ 10-24，上週 snapshot = 10-17
const base = () => ({
  favourites: [{ id: 1, name: "泓景臺<img src=x onerror=alert(1)>" }],
  wStart: "2026-10-18", wEnd: "2026-10-24", txnFrom: "2026-07-26",
  snap: { 1: { nowD: "2026-10-24", prevD: "2026-10-17", m4D: null } },
  listings: [
    { estate_id: 1, d: "2026-10-24", source: "centanet", ref_no: "A", b: "8座", f: "10樓", u: "H室", beds: 2, s: 500, p: 7850000, psf: 15700, url: "https://hk.centanet.com/x" },
    { estate_id: 1, d: "2026-10-24", source: "centanet", ref_no: "B", b: "3座", f: "5樓", u: "A室", beds: 2, s: 480, p: 7000000, psf: 14583 },
    { estate_id: 1, d: "2026-10-17", source: "centanet", ref_no: "A", b: "8座", f: "10樓", u: "H室", beds: 2, s: 500, p: 7980000, psf: 15960 },
    { estate_id: 1, d: "2026-10-17", source: "centanet", ref_no: "C", b: "1座", f: "2樓", u: "B室", beds: 2, s: 450, p: 6500000, psf: 14444 },
  ],
  txns: [{ estate_id: 1, b: "1座", f: "3樓", u: "A室", p: 7000000, s: 480, psf: 16000, reg_date: "2026-10-01", first_seen: "2026-10-20" }],
  favListings: [{ estate_id: 1, ref_no: "A" }, { estate_id: 1, ref_no: "C" }],
  viewings: [], prefs: { price_max: 800, beds: "2" },
});

describe("computeWeekly", () => {
  it("沒有最愛屋苑 → skip", () => {
    expect(computeWeekly({ favourites: [] })).toEqual({ status: "skip", reason: "no_favourites" });
  });
  it("最新 snapshot 過期 → 該屋苑唔計，全部過期就 skip（唔用舊數據扮本週）", () => {
    const i = base(); i.snap[1].nowD = "2026-10-20";
    const w = computeWeekly(i);
    expect(w.status).toBe("skip"); expect(w.reason).toBe("stale_data");
  });
  it("改價、下架、新盤、成交數得啱；冇變動唔入 moves", () => {
    const w = computeWeekly(base());
    expect(w.status).toBe("ok");
    expect(w.cards[0]).toMatchObject({ nNow: 2, nCut: 1, nNew: 1, nRemoved: 1, nTx: 1, hasPrev: true });
    const kinds = Object.fromEntries(w.moves.map((m) => [m.ref, m.kind]));
    expect(kinds).toEqual({ A: "price", C: "gone" });
    expect(w.moves.find((m) => m.ref === "A").ch).toBeCloseTo(-1.63, 1);
  });
  it("本週減價最大、預算內盤數、新成交一覽", () => {
    const w = computeWeekly(base());
    expect(w.topCuts.map((c) => c.label)).toEqual(["8座 10樓 H室"]);
    expect(w.topCuts[0].pct).toBeCloseTo(1.63, 1);
    expect(w.budget).toEqual({ now: 2, delta: 0 });          // 2房、≤800萬：本週 A、B；上週 A、C
    expect(w.weekTxnTotal).toBe(1);
    expect(w.weekTxns[0]).toMatchObject({ label: "1座 3樓 A室", p: 7000000 });
    expect(w.weekTxns[0].vs).toBeCloseTo((16000 / w.cards[0].aNow - 1) * 100, 5);
  });
  it("冇上週 snapshot → 唔扮有比較（aPrev null）", () => {
    const i = base(); i.snap[1].prevD = null;
    const c = computeWeekly(i).cards[0];
    expect(c.hasPrev).toBe(false); expect(c.aPrev).toBeNull(); expect(c.nRemoved).toBe(0);
  });
});

describe("renderWeeklyHtml", () => {
  it("動態字串全部 escape", () => {
    const w = computeWeekly(base());
    const html = renderWeeklyHtml(w, { appUrl: "https://x/app", unsubUrl: "https://x/u?a=1&kind=weekly", iconUrl: "https://x/i.png",
      prefLabel: "2房、$800萬以下", srcName: (s) => ({ centanet: "中原" }[s] || s) });
    expect(html).toContain("中原 ↗");                    // 減價 Top 3 有連結，顯示來源網站
    expect(html).not.toContain("<img src=x");            // 屋苑名 escape
    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain("值得留意");               // 已由每日 email 獨佔
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("kind=weekly");
    expect(weeklySubject(w)).toContain("10月18日–10月24日");
    expect(weeklyHeadline(w)).toContain("你 1 個最愛屋苑本週");
  });
});

// ── 待跟進（睇樓記錄欠資料／未對應放盤）──
const V = (o = {}) => ({ id: 1, estate_name: "泓景臺", view_date: "2026-10-20", block: "8座", floor: "10", unit: "H", price: 7800000, deal_type: "S", linked_ref_no: "ABC123", dismissed_refs: null, sold: 0, ...o });
const T = (vs, extra = {}) => weeklyTodos({ viewings: vs, dismissed: [], linkMaxDays: 30, today: "2026-10-24", ...extra });
const infoOf = (vs, extra) => T(vs, extra).items.map((i) => [i.id, i.missing.join("+"), i.needLink]);

describe("weeklyTodos", () => {
  it("填齊＋已對應 → 唔提", () => expect(T([V()]).total).toBe(0));
  it("欠樓層／室／價／座各自列明；租盤叫睇樓租金", () => {
    expect(infoOf([V({ floor: "", unit: "", price: 0, block: "", linked_ref_no: null })])).toEqual([[1, "座+樓層+室+睇樓價", false]]);
    expect(infoOf([V({ price: 0, deal_type: "R" })])).toEqual([[1, "睇樓租金", false]]);
  });
  it("未對應放盤：要有座＋室、冇 linked_ref_no", () => {
    expect(infoOf([V({ linked_ref_no: "" })])).toEqual([[1, "", true]]);
    expect(infoOf([V({ linked_ref_no: null, unit: "" })])).toEqual([[1, "室", false]]);   // 欠室 → 冇得對應，淨係提欠室
  });
  it("睇樓超過 30 日唔再提「未對應」，但欠資料照提", () => {
    expect(T([V({ view_date: "2026-09-01", linked_ref_no: null })]).total).toBe(0);
    expect(infoOf([V({ view_date: "2026-09-01", linked_ref_no: null, price: 0 })])).toEqual([[1, "睇樓價", false]]);
    expect(T([V({ view_date: "2026-09-01", linked_ref_no: null })], { linkMaxDays: 90 }).total).toBe(1);   // ⚙️ todo_link_max_days 跟設定
  });
  it("已成交、用戶 ✕ 唔再提醒、全部放盤都 ✕ 過 → 唔提", () => {
    expect(T([V({ sold: 1, price: 0 })]).total).toBe(0);
    expect(T([V({ price: 0 })], { dismissed: [1] }).total).toBe(0);
    expect(T([V({ linked_ref_no: null, dismissed_refs: '["X1","X2"]' })]).total).toBe(0);
  });
  it("最近睇嘅排先", () => {
    const r = T([V({ id: 1, view_date: "2026-10-01", price: 0 }), V({ id: 2, view_date: "2026-10-22", price: 0 }), V({ id: 3, view_date: "2026-10-10", price: 0 })]);
    expect(r.items.map((i) => i.id)).toEqual([2, 3, 1]);
  });
});

describe("每週摘要：待跟進 section", () => {
  const opts = { appUrl: "https://x/app", unsubUrl: "https://x/u", iconUrl: "https://x/i.png" };
  const withTodo = (n) => { const inp = base(); inp.todoViewings = Array.from({ length: n }, (_, i) => V({ id: i + 1, estate_name: "宇晴軒<img src=x onerror=alert(9)>", view_date: `2026-10-${String(10 + i).padStart(2, "0")}`, price: 0, linked_ref_no: "R" })); inp.todoDismissed = []; return renderWeeklyHtml(computeWeekly(inp), opts); };
  it("最多列 5 條，其餘寫「另有 N 個」；標題寫總數；動態字串 escape", () => {
    const html = withTodo(8);
    expect(html).toContain("有 8 個睇樓記錄等你跟進");
    expect(html.match(/欠 睇樓價/g).length).toBe(5);
    expect(html).toContain("另有 3 個，返 app 睇全部");
    expect(html).toContain("返 app 補資料");
    expect(html).not.toContain("<img src=x"); expect(html).toContain("&lt;img src=x");
  });
  it("冇待辦就唔出呢個 section", () => {
    expect(withTodo(0)).not.toContain("等你跟進");
    const inp = base();   // 冇 todoViewings 欄位（舊 caller）亦唔爆
    expect(renderWeeklyHtml(computeWeekly(inp), opts)).not.toContain("等你跟進");
  });
});

describe("email 頂部 app 連結（唔使碌到底先搵到）", () => {
  it("header 有「打開 app」掣，喺 headline 之前；底部 CTA 同頁尾字有間距", () => {
    const html = renderWeeklyHtml(computeWeekly(base()), { appUrl: "https://x/app", unsubUrl: "https://x/u", iconUrl: "https://x/i.png" });
    const top = html.indexOf("打開 app →"), headline = html.indexOf("你 1 個最愛屋苑本週"), bottom = html.indexOf("打開搵樓日記睇詳情");
    expect(top).toBeGreaterThan(0); expect(top).toBeLessThan(headline); expect(headline).toBeLessThan(bottom);
    expect(html).toContain("margin:28px 0 38px");
  });
});

describe("weeklyIsEmpty（本週冇更新就唔寄）", () => {
  const W = (o = {}) => ({ totals: { newN: 0, cut: 0, tx: 0 }, moves: [], todo: { total: 0, items: [] }, ...o });
  it("市場冇動靜、冇待跟進 → 空", () => expect(weeklyIsEmpty(W())).toBe(true));
  it("市場冇動靜但有待跟進 → 照寄（用戶決定）", () => expect(weeklyIsEmpty(W({ todo: { total: 3, items: [{}] } }))).toBe(false));
  it("有新盤／減價／成交／你睇過嘅盤變動 → 唔空", () => {
    expect(weeklyIsEmpty(W({ totals: { newN: 1, cut: 0, tx: 0 } }))).toBe(false);
    expect(weeklyIsEmpty(W({ totals: { newN: 0, cut: 2, tx: 0 } }))).toBe(false);
    expect(weeklyIsEmpty(W({ totals: { newN: 0, cut: 0, tx: 1 } }))).toBe(false);
    expect(weeklyIsEmpty(W({ moves: [{}] }))).toBe(false);
  });
  it("真實 computeWeekly 輸出：有更新唔空", () => expect(weeklyIsEmpty(computeWeekly(base()))).toBe(false));
});
