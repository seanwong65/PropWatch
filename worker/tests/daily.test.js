import { describe, it, expect } from "vitest";
import { renderDailyHtml, dailyHeadline, dailySubject } from "../daily.js";
import { dedupePicks } from "../index.js";

const seg = (start, price, prev) => ({ start, end: start, price, prev });
const fixture = () => ({
  date: "2026-10-23",
  linkedPriceChanges: [{ estate_name: "泓景臺", building_name: "8座", floor: "低層", l_unit: "H室", size_net: 477, price_per_ft: 17086,
    view_price: 8100000, new_price: 8150000, old_price: 7850000, detail_url: "https://www.midland.com.hk/x", source: "midland",
    history: [seg("2026-08-20", 8150000, null), seg("2026-08-23", 8080000, 8150000), seg("2026-09-09", 8150000, 8080000), seg("2026-10-23", 8150000, 7850000)] }],
  linkedRemoved: [], allViewedTxns: [], linkedRentPriceChanges: [], linkedRentRemoved: [], allViewedRentTxns: [],
  byEstate: [
    { estate: "宇晴軒<img src=x onerror=alert(1)>", newTransactions: [],
      priceChanges: [{ building_name: "6座", floor: "中層", unit: "D室", size_net: 449, price_per_ft: 16881, new_price: 7580000, old_price: 7830000, detail_url: "https://hk.centanet.com/y", source: "centanet" }],
      newListings: [{ building_name: "7座", floor: "高層", unit: "E室", bedrooms: 2, size_net: 445, price: 7800000, price_per_ft: 17528, detail_url: "javascript:alert(1)", source: "midland" }],
      removedListings: [{}] },
    { estate: "泓景臺", newTransactions: [], priceChanges: [], newListings: [], removedListings: [] },
    { estate: "黃埔花園", newTransactions: Array.from({ length: 7 }, (_, i) => ({ building: "11座", floor: "6樓", unit: `D${i}室`, size_net: 466, price_per_ft: 16309, reg_date: "2026-10-21", price: 7600000, held_days: 3650, gain_pct: 2 })),
      priceChanges: [], newListings: [], removedListings: [] },
  ],
  byEstateRent: [
    { estate: "宇晴軒", newRentals: [{ building_name: "3座", floor: "高層", unit: "H室", bedrooms: 2, size_net: 467, price_per_ft: 51, price: 24000, detail_url: "https://www.ricacorp.com/z", source: "ricacorp" }], rentPriceChanges: [], newRentTransactions: [], removedRentals: [] },
    { estate: "泓景臺", newRentals: [], rentPriceChanges: [{ building_name: "7座", floor: "低層", unit: "H室", size_net: 440, price_per_ft: 55, new_price: 24000, old_price: 23000, detail_url: "https://www.ricacorp.com/w", source: "ricacorp" }], newRentTransactions: [], removedRentals: [] },
  ],
});
const opts = { appUrl: "https://x/app", unsubUrl: "https://x/u", iconUrl: "https://x/i.png", prefLabel: "2房、$800萬以下", srcName: (s) => ({ midland: "美聯", centanet: "中原", ricacorp: "利嘉閣" }[s] || s) };
const pick = (o = {}) => ({ name: "昇悅居", label: "2座 低層 F室", price: 7800000, size: 523, beds: 2, reasons: ["呎價低過屋苑成交中位 11%"], url: "https://m/1", source: "midland", unit: "F室", floorTier: "低層", ...o });

describe("renderDailyHtml", () => {
  const html = renderDailyHtml(fixture(), [pick()], opts);
  it("買盤、租盤各一個大框，屋苑做小標題（冇動態嘅屋苑唔出）", () => {
    expect(html.split("🏢 買盤動態").length).toBe(2);
    expect(html.split("🔑 租盤動態").length).toBe(2);
    expect(html).toContain("黃埔花園");
    // 買盤部分冇動態嘅泓景臺唔應該有小標題（租盤部分有，所以只會出現一次）
    expect(html.split(">泓景臺</td>").length).toBe(2);
  });
  it("改價記錄：每個價位一粒標籤、藍色箭頭", () => {
    expect(html.match(/border-radius:8px;padding:2px 7px/g).length).toBe(4);
    expect(html).toContain('#1270ac;font-size:15px;font-weight:700"> → </span>');
  });
  it("連結顯示來源網站；非 https 連結唔出；動態字串 escape", () => {
    expect(html).toContain("美聯 ↗"); expect(html).toContain("中原 ↗"); expect(html).toContain("利嘉閣 ↗");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img src=x"); expect(html).toContain("&lt;img src=x");
  });
  it("每項最多 5 行，多出寫另有 N 個；細幅變價唔逐條列", () => {
    expect(html).toContain("另有 2 個，返 app 睇全部");
    const f = fixture(); f.byEstate[0].priceChanges.push({ building_name: "1座", floor: "低層", unit: "A室", new_price: 7790000, old_price: 7800000 });
    expect(renderDailyHtml(f, [], opts)).toContain("另有 1 個細幅變動");
  });
  it("行數上限、變價門檻跟設定（listCap／minMovePct）", () => {
    const h2 = renderDailyHtml(fixture(), [], { ...opts, listCap: 2, minMovePct: 0 });
    expect(h2).toContain("另有 5 個，返 app 睇全部");     // 黃埔 7 宗成交，上限 2
    const f = fixture(); f.byEstate[0].priceChanges.push({ building_name: "1座", floor: "低層", unit: "A室", new_price: 7790000, old_price: 7800000 });
    expect(renderDailyHtml(f, [], { ...opts, minMovePct: 0 })).not.toContain("細幅變動");
  });
  it("標題／主旨", () => {
    expect(dailyHeadline(fixture())).toContain("你睇過嘅盤有 1 個變動");
    expect(dailySubject(fixture(), 2)).toContain("2 個值得留意");
    expect(dailySubject({}, 0)).toBe("搵樓日記通知：今日無更新");
  });
});

describe("dedupePicks", () => {
  it("同一單位喺兩個網站（座數寫法唔同）只列一次，連結併入", () => {
    const r = dedupePicks([pick(), pick({ label: "3座 低層 F室", size: 522, url: "https://r/1", source: "ricacorp" })]);
    expect(r).toHaveLength(1);
    expect(r[0].also).toEqual([{ url: "https://r/1", source: "ricacorp" }]);
  });
  it("價錢或單位字母唔同就唔併", () => {
    expect(dedupePicks([pick(), pick({ price: 7900000 })])).toHaveLength(2);
    expect(dedupePicks([pick(), pick({ unit: "G室" })])).toHaveLength(2);
  });
});
