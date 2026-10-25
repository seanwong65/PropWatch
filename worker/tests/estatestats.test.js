import { describe, it, expect } from "vitest";
import { statsFromSnapshots, weekChangesFromSnapshots, weekTxnsFrom } from "../estateStats.js";

const L = (source, d, ref, b, f, u, s, p, psf) => ({ source, d, ref_no: ref, b, f, u, s, p, psf });
describe("statsFromSnapshots", () => {
  const now = [
    L("centanet", "2026-10-23", "A", "1座", "低層", "A室", 500, 7800000, 15600),
    L("midland", "2026-10-23", "A2", "1座", "低層", "A室", 500, 7800000, 15600),   // 同一單位喺第二個網站 → 只計一個單位
    L("centanet", "2026-10-23", "B", "1座", "高層", "B室", 400, 6000000, 15000),
    L("centanet", "2026-10-23", "N", "2座", "中層", "C室", 450, 6750000, 15000),   // 新盤
  ];
  const prev = [
    L("centanet", "2026-10-16", "A", "1座", "低層", "A室", 500, 8000000, 16000),   // 減價
    L("midland", "2026-10-16", "A2", "1座", "低層", "A室", 500, 8000000, 16000),
    L("centanet", "2026-10-16", "B", "1座", "高層", "B室", 400, 6000000, 15000),
    L("centanet", "2026-10-16", "G", "3座", "低層", "D室", 420, 6300000, 15000),   // 下架
  ];
  it("在售數、呎價中位、新盤／下架／減價、叫價 vs 成交", () => {
    const s = statsFromSnapshots({ now, prev, txPsf: [14000, 14500, 15000, 15500, 16000] });
    expect(s).toMatchObject({ as_of: "2026-10-23", prev_as_of: "2026-10-16", span_days: 7, n: 3, n_prev: 3, new: 1, removed: 1, cuts: 2 });
    expect(s.psf).toBe(15000); expect(s.tx_psf).toBe(15000); expect(s.gap).toBe(0);
    expect(s.psf_prev).toBe(15000);
  });
  it("冇上週 snapshot → 變動欄位係 null（數據累積中），唔扮 0", () => {
    const s = statsFromSnapshots({ now, prev: [], txPsf: [] });
    expect(s.new).toBeNull(); expect(s.removed).toBeNull(); expect(s.cuts).toBeNull(); expect(s.span_days).toBeNull(); expect(s.psf_prev).toBeNull();
    expect(s.n).toBe(3);
  });
  it("成交少過 5 宗唔計叫價 vs 成交", () => {
    const s = statsFromSnapshots({ now, prev, txPsf: [1000, 2000, 3000] });
    expect(s.tx_n).toBe(3); expect(s.tx_psf).toBeNull(); expect(s.gap).toBeNull();
  });
  it("新加入嘅 source（上週冇 snapshot）唔會令全部盤變新盤", () => {
    const n2 = [...now, L("hkp", "2026-10-23", "H1", "5座", "低層", "E室", 480, 7000000, 14583)];
    const s = statsFromSnapshots({ now: n2, prev, txPsf: [] });
    expect(s.new).toBe(1);
  });
  it("完全冇 snapshot → null", () => {
    expect(statsFromSnapshots({ now: [], prev: [], txPsf: [] })).toBeNull();
  });
});

describe("weekChangesFromSnapshots（本週變動面板）", () => {
  const X = (source, d, ref, b, f, u, s, p, psf, extra = {}) => ({ source, d, ref_no: ref, b, f, u, s, p, psf, beds: 2, url: `https://x/${ref}`, lid: "L" + ref, ...extra });
  const now = [X("centanet", "2026-10-23", "A", "1座", "低層", "A室", 500, 7800000, 15600), X("midland", "2026-10-23", "A2", "1座", "低層", "A室", 500, 7800000, 15600),
    X("centanet", "2026-10-23", "B", "1座", "高層", "B室", 400, 6000000, 15000), X("centanet", "2026-10-23", "N", "2座", "中層", "C室", 450, 6750000, 15000)];
  const prev = [X("centanet", "2026-10-16", "A", "1座", "低層", "A室", 500, 8000000, 16000), X("midland", "2026-10-16", "A2", "1座", "低層", "A室", 500, 8000000, 16000),
    X("centanet", "2026-10-16", "B", "1座", "高層", "B室", 400, 6000000, 15000), X("centanet", "2026-10-16", "G", "3座", "低層", "D室", 420, 6300000, 15000)];
  it("條數同卡片（statsFromSnapshots）完全一致，內容對得上", () => {
    const w = weekChangesFromSnapshots({ now, prev }), st = statsFromSnapshots({ now, prev, txPsf: [] });
    expect([w.counts.new, w.counts.cuts, w.counts.removed]).toEqual([st.new, st.cuts, st.removed]);
    expect(w.new.map((r) => r.ref)).toEqual(["N"]);
    expect(w.removed.map((r) => r.ref)).toEqual(["G"]);
    expect(w.cuts.map((r) => [r.ref, r.from, r.to, r.pct]).sort()).toEqual([["A", 8000000, 7800000, -2.5], ["A2", 8000000, 7800000, -2.5]]);
  });
  it("新加入嘅 source（上週冇 snapshot）唔會令全部盤變新盤", () => {
    const w = weekChangesFromSnapshots({ now: [...now, X("hkp", "2026-10-23", "H1", "9座", "低層", "A室", 300, 5000000, 16000)], prev });
    expect(w.counts.new).toBe(1);
  });
  it("冇上週 snapshot → hasPrev=false", () => expect(weekChangesFromSnapshots({ now, prev: [] }).hasPrev).toBe(false));
  it("排序：減價跌幅最大排先；每類最多 cap 條但總數照回", () => {
    const many = Array.from({ length: 5 }, (_, i) => X("centanet", "2026-10-23", "C" + i, "1座", "低層", "A室", 400, 6000000 - i * 100000, 15000));
    const old = many.map((r) => ({ ...r, d: "2026-10-16", p: 6000000 + 0 }));
    const w = weekChangesFromSnapshots({ now: many, prev: old, cap: 2 });
    expect(w.counts.cuts).toBe(4); expect(w.cuts).toHaveLength(2); expect(w.cuts[0].ref).toBe("C4");
  });
});

describe("weekTxnsFrom", () => {
  const t = (reg, first, price, psf = 16000) => ({ building: "1座", floor: "5樓", unit: "A室", price, size_net: 400, price_per_ft: psf, reg_date: reg, first_seen: first });
  it("只計 first_seen 喺最近 7 日；vs＝比叫價呎價中位高低 %", () => {
    const r = weekTxnsFrom([t("2026-10-21", "2026-10-22", 8000000, 15200), t("2026-09-01", "2026-09-02", 7000000), t("2026-10-05", "2026-10-06", 7500000)], "2026-10-23", 16000);
    expect(r.total).toBe(1); expect(r.items[0]).toMatchObject({ p: 8000000, reg: "2026-10-21", vs: -5 });
  });
});
