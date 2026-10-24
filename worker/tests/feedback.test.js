import { describe, it, expect } from "vitest";
import { parseFeedback, sniffImage, maskEmail } from "../index.js";

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

describe("sniffImage（附圖只信檔頭）", () => {
  const pad = (a) => new Uint8Array([...a, ...new Array(16).fill(0)]);
  it("JPEG／PNG／WebP", () => {
    expect(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ mime: "image/jpeg", ext: "jpg" });
    expect(sniffImage(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({ mime: "image/png", ext: "png" });
    expect(sniffImage(pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toEqual({ mime: "image/webp", ext: "webp" });
  });
  it("其他一律拒絕（GIF／SVG／HTML／太短）", () => {
    expect(sniffImage(pad([0x47, 0x49, 0x46, 0x38]))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe("maskEmail（Telegram 通知打碼）", () => {
  it("保留頭尾字元同域名", () => {
    expect(maskEmail("johnwong777@hotmail.com")).toBe("j***7@hotmail.com");
    expect(maskEmail("ab@x.com")).toBe("a*@x.com");
    expect(maskEmail("a@x.com")).toBe("a*@x.com");
    expect(maskEmail("")).toBe("（冇 email）");
    expect(maskEmail("no-at-sign")).toBe("（冇 email）");
  });
});
