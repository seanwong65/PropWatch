import { describe, it, expect } from "vitest";
import { computeWeekly, renderWeeklyHtml, weeklyHeadline, weeklySubject } from "../weekly.js";

// 2026-10-24（六）寄信；本週 = 10-18 ~ 10-24，上週 snapshot = 10-17
const base = () => ({
  favourites: [{ id: 1, name: "泓景臺<img src=x onerror=alert(1)>" }],
  wStart: "2026-10-18", wEnd: "2026-10-24", txnFrom: "2026-07-26",
  snap: { 1: { nowD: "2026-10-24", prevD: "2026-10-17", m4D: null } },
  listings: [
    { estate_id: 1, d: "2026-10-24", source: "centanet", ref_no: "A", b: "8座", f: "10樓", u: "H室", beds: 2, s: 500, p: 7850000, psf: 15700 },
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
  it("冇上週 snapshot → 唔扮有比較（aPrev null）", () => {
    const i = base(); i.snap[1].prevD = null;
    const c = computeWeekly(i).cards[0];
    expect(c.hasPrev).toBe(false); expect(c.aPrev).toBeNull(); expect(c.nRemoved).toBe(0);
  });
});

describe("renderWeeklyHtml", () => {
  it("動態字串全部 escape", () => {
    const w = computeWeekly(base());
    const picks = [{ name: "泓景臺<b>", label: "6座 低層 B室", price: 7580000, size: 473, beds: 2, reasons: ["呎價低過屋苑成交中位 9%"], url: "https://hk.centanet.com/x", source: "centanet" },
      { name: "X", label: "Y", price: 1, size: 1, beds: 1, reasons: [], url: "javascript:alert(1)", source: "midland" }];
    const html = renderWeeklyHtml(w, { appUrl: "https://x/app", unsubUrl: "https://x/u?a=1&kind=weekly", iconUrl: "https://x/i.png",
      picks, prefLabel: "2房、$800萬以下", srcName: (s) => ({ centanet: "中原" }[s] || s) });
    expect(html).toContain("中原 ↗");                    // 值得留意有連結，顯示來源網站
    expect(html).not.toContain("javascript:");           // 非 https 連結一律唔出
    expect(html).toContain("泓景臺&lt;b&gt;");           // 屋苑名 escape
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("kind=weekly");
    expect(weeklySubject(w)).toContain("10月18日–10月24日");
    expect(weeklyHeadline(w)).toContain("你 1 個最愛屋苑本週");
  });
});
