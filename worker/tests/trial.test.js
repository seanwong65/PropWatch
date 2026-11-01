// 新用戶免費試用收費版（2026-11-01）：試用完結 email 字眼＋到期日計法
import { describe, it, expect } from "vitest";
import { expiredEmail, expiredSubject } from "../lifecycle.js";
import { hkAddMonths } from "../index.js";

describe("試用完結 email", () => {
  it("講明係免費試用完結、唔會扣錢、資料保留、可以訂閱", () => {
    const h = expiredEmail({ appUrl: "https://x/app", iconUrl: "https://x/i.png", reason: "trial", periodEnd: "2027-02-01", cap: 3, pausedCount: 2 });
    expect(expiredSubject({ reason: "trial" })).toContain("免費試用");
    expect(h).toContain("免費試用已完結"); expect(h).toContain("2027年2月1日"); expect(h).toContain("唔會扣你任何錢");
    expect(h).toContain("全部保留"); expect(h).toContain("2 個屋苑暫停咗追蹤"); expect(h).toContain("可以訂閱收費版");
    expect(h).not.toContain("一路支持");
  });
});

describe("hkAddMonths", () => {
  it("普通、跨年、月尾唔夠日用嗰個月最後一日", () => {
    expect(hkAddMonths(3, "2026-11-01")).toBe("2027-02-01");
    expect(hkAddMonths(6, "2026-11-15")).toBe("2027-05-15");
    expect(hkAddMonths(1, "2027-01-31")).toBe("2027-02-28");
    expect(hkAddMonths(1, "2028-01-31")).toBe("2028-02-29");
    expect(hkAddMonths(3, "2026-11-30")).toBe("2027-02-28");
    expect(hkAddMonths(12, "2026-12-31")).toBe("2027-12-31");
  });
});
