import { describe, it, expect } from "vitest";
import { expiredEmail, expiredSubject, paymentFailedEmail, paymentFailedSubject } from "../lifecycle.js";

const base = { appUrl: "https://x/app", iconUrl: "https://x/i.png" };

describe("收費版生命週期 email", () => {
  it("到期：標題、日期、資料保留、暫停屋苑數、鎖住清單", () => {
    const h = expiredEmail({ ...base, reason: "expired", periodEnd: "2026-12-31", cap: 3, pausedCount: 4 });
    expect(h).toContain("收費版已到期"); expect(h).toContain("2026年12月31日");
    expect(h).toContain("全部保留"); expect(h).toContain("4 個屋苑暫停咗追蹤"); expect(h).toContain("追蹤屋苑上限 <b>3 個</b>");
    expect(h).toContain("https://x/app"); expect(expiredSubject({ reason: "expired" })).toContain("到期");
    expect(h).toContain("俾下我杯咖啡錢");
  });
  it("到期：冇暫停屋苑就唔提；取消訂閱用「已結束」字眼", () => {
    expect(expiredEmail({ ...base, pausedCount: 0 })).not.toContain("暫停咗追蹤");
    const c = expiredEmail({ ...base, reason: "canceled" });
    expect(c).toContain("收費版已結束"); expect(c).toContain("已經取消");
    expect(expiredSubject({ reason: "canceled" })).toContain("結束");
  });
  it("扣款失敗：講清楚「而家照用」、下次重試日期、每日 email 暫停、之後仍失敗先轉免費；冇重試日期就叫用戶自己更新", () => {
    const h = paymentFailedEmail({ ...base, amount: "HK$400", nextTry: "2026-11-02" });
    expect(h).toContain("HK$400"); expect(h).toContain("照常可以用"); expect(h).toContain("2026年11月2日"); expect(h).toContain("再自動扣款一次");
    expect(h).toContain("每日 email 會暫停"); expect(h).toContain("如果之後仍然扣唔到"); expect(h).not.toContain("日後");
    expect(paymentFailedEmail({ ...base, amount: "" })).toContain("暫時唔會再自動重試");
    expect(paymentFailedSubject()).toContain("扣款唔成功");
  });
  it("動態字串 escape", () => {
    const h = paymentFailedEmail({ ...base, amount: "<img src=x onerror=alert(1)>" });
    expect(h).not.toContain("<img src=x"); expect(h).toContain("&lt;img src=x");
  });
});
