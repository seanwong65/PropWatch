import { describe, it, expect } from "vitest";
import { parseFeedback } from "../index.js";

describe("parseFeedback", () => {
  it("正常意見", () => {
    expect(parseFeedback({ category: "功能建議", message: "  希望可以加多個比較屋苑嘅功能  ", context: "iPhone Safari" }))
      .toEqual({ category: "功能建議", message: "希望可以加多個比較屋苑嘅功能", context: "iPhone Safari" });
  });
  it("類別要喺白名單", () => {
    expect(parseFeedback({ category: "垃圾", message: "12345678" }).error).toBeTruthy();
    expect(parseFeedback({ message: "12345678" }).error).toBeTruthy();
    expect(parseFeedback(null).error).toBeTruthy();
  });
  it("太短／太長／控制字元", () => {
    expect(parseFeedback({ category: "其他", message: "好" }).error).toContain("太短");
    expect(parseFeedback({ category: "其他", message: "字".repeat(2001) }).error).toContain("太長");
    expect(parseFeedback({ category: "其他", message: "字".repeat(2000) }).error).toBeUndefined();
    expect(parseFeedback({ category: "其他", message: "你好\u0000世界\u0007，測試" }).message).toBe("你好世界，測試");
  });
  it("保留換行；context 截 300 字；非字串當空", () => {
    const r = parseFeedback({ category: "問題回報", message: "第一行\n第二行 abc", context: "x".repeat(500) });
    expect(r.message).toBe("第一行\n第二行 abc");
    expect(r.context).toHaveLength(300);
    expect(parseFeedback({ category: "其他", message: "12345678", context: { a: 1 } }).context).toBe("[object Object]".slice(0, 300));
  });
});
