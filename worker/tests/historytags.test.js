// 搵盤「有歷史記錄」標記（2026-11-02）：地產網連結 → ref_no（唔估，唔認得就 null）＋價錢歷史摘要
import { describe, it, expect } from "vitest";
import { refFromPortalUrl, historySummary } from "../index.js";

describe("refFromPortalUrl", () => {
  it("四個網站嘅放盤連結（同資料庫 ref_no 一樣）", () => {
    expect(refFromPortalUrl("https://hk.centanet.com/findproperty/detail/%E5%A4%AA%E5%8F%A4%E5%9F%8E_DAR740")).toBe("DAR740");
    expect(refFromPortalUrl("https://www.midland.com.hk/zh-hk/property/%E6%B8%AF%E5%B3%B6-%E5%A4%AA%E5%8F%A4-M151828301")).toBe("M151828301");
    expect(refFromPortalUrl("https://www.hkp.com.hk/zh-hk/property/%E6%B8%AF%E5%B3%B6-H100221741")).toBe("H100221741");
    expect(refFromPortalUrl("https://www.ricacorp.com/zh-hk/property/detail/%E5%A4%AA%E5%8F%A4%E5%9F%8E-hma-cm77970685-3-hk")).toBe("CM77970685");
    expect(refFromPortalUrl("https://www.ricacorp.com/zh-hk/property/detail/x-hma-cc91285039-5-hk")).toBe("CC91285039");   // 租盤 -5-hk
    expect(refFromPortalUrl("https://hk.centanet.com/findproperty/detail/%E6%B7%98_SRB491")).toBe("SRB491");
  });
  it("唔認得／唔係 https／其他網站 → null", () => {
    expect(refFromPortalUrl("http://hk.centanet.com/findproperty/detail/x_DAR740")).toBeNull();
    expect(refFromPortalUrl("https://evil.com/findproperty/detail/x_DAR740")).toBeNull();
    expect(refFromPortalUrl("https://www.midland.com.hk/zh-hk/estate/xxx")).toBeNull();
    expect(refFromPortalUrl("javascript:alert(1)")).toBeNull();
    expect(refFromPortalUrl("not a url")).toBeNull();
  });
});

describe("historySummary", () => {
  it("減價／加價次數、最初同而家價、最少放咗幾耐", () => {
    const rows = [{ price: 7000000, snapshot_date: "2026-09-18" }, { price: 6800000, snapshot_date: "2026-10-10" }, { price: 6800500, snapshot_date: "2026-10-20" }, { price: 6880000, snapshot_date: "2026-10-25" }, { price: 6680000, snapshot_date: "2026-11-01" }];
    expect(historySummary(rows, "2026-11-02")).toEqual({ days: 45, cuts: 2, ups: 1, from: 7000000, to: 6680000 });
    expect(historySummary([], "2026-11-02")).toBeNull();
  });
  it("租盤門檻 $100：減租 $500 都算", () => {
    const rows = [{ price: 18000, snapshot_date: "2026-10-01" }, { price: 17500, snapshot_date: "2026-10-20" }];
    expect(historySummary(rows, "2026-11-02", 100)).toMatchObject({ cuts: 1, from: 18000, to: 17500 });
    expect(historySummary(rows, "2026-11-02")).toMatchObject({ cuts: 0 });   // 買盤門檻就唔算
  });
});
