// listing_price_history 稀疏化（2026-10-29）：價錢有變先 insert，冇變淨係 update seen_until。
// 用 Miniflare（同 D1 一樣嘅 workerd SQLite）驗：行為、listing_price_seen 同步、D1 寫入行數。
// 大規模語意對照（正式數據 14.8 萬行重播、64 萬個 ref×日子組合）見 docs/NOTES.md。
import { describe, it, expect, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { LPH_TOUCH_SQL, LPH_INSERT_SQL, TRG_LPH_SEEN_UPD, TRG_LPH_SEEN_DEL, TRG_LPH_SEEN_UNTIL, lphRowAtSql, expandPriceRuns, collapsePriceHistory } from "../index.js";

const mf = new Miniflare({ modules: true, script: "export default { fetch(){ return new Response('x') } }", d1Databases: ["DB"] });
afterAll(() => mf.dispose());
async function setup() {
  const db = await mf.getD1Database("DB");
  for (const s of ["DROP TABLE IF EXISTS listing_price_history", "DROP TABLE IF EXISTS listing_price_seen"]) await db.prepare(s).run();
  await db.prepare(`CREATE TABLE listing_price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ref_no TEXT NOT NULL, estate_id INTEGER NOT NULL,
    price REAL NOT NULL, price_per_ft REAL, snapshot_date TEXT NOT NULL, seen_until TEXT, UNIQUE(ref_no, snapshot_date))`).run();
  await db.prepare("CREATE INDEX idx_lph_estate_ref ON listing_price_history(estate_id, ref_no, snapshot_date)").run();
  await db.prepare("CREATE TABLE listing_price_seen (ref_no TEXT NOT NULL, price REAL NOT NULL, last_date TEXT NOT NULL, PRIMARY KEY (ref_no, price)) WITHOUT ROWID").run();
  await db.prepare(`CREATE TRIGGER trg_lph_seen_ins AFTER INSERT ON listing_price_history BEGIN
    INSERT INTO listing_price_seen (ref_no, price, last_date) VALUES (NEW.ref_no, NEW.price, NEW.snapshot_date)
    ON CONFLICT(ref_no, price) DO UPDATE SET last_date = MAX(last_date, excluded.last_date); END`).run();
  for (const t of [TRG_LPH_SEEN_UPD, TRG_LPH_SEEN_DEL, TRG_LPH_SEEN_UNTIL]) await db.prepare(t).run();
  return db;
}
// 一日 sync 一個盤：兩句一齊 batch（同 save*Listings 一樣），回傳 D1 寫入行數
async function day(db, ref, price, date) {
  const rs = await db.batch([db.prepare(LPH_TOUCH_SQL).bind(ref, price, date), db.prepare(LPH_INSERT_SQL).bind(ref, price, date, 1, 10000)]);
  return rs.reduce((n, r) => n + (r.meta.rows_written || 0), 0);
}
const rows = async (db) => (await db.prepare("SELECT price, snapshot_date, seen_until FROM listing_price_history WHERE ref_no = 'A' ORDER BY snapshot_date").all()).results;
const seen = async (db) => (await db.prepare("SELECT price, last_date FROM listing_price_seen WHERE ref_no = 'A' ORDER BY price").all()).results;

describe("listing_price_history 稀疏寫入", () => {
  it("價錢冇變淨係延長 seen_until；改價先 insert；改返舊價都係新一段", async () => {
    const db = await setup();
    const w1 = await day(db, "A", 800, "2026-10-01");
    const w2 = await day(db, "A", 800, "2026-10-02");
    const w3 = await day(db, "A", 800, "2026-10-03");
    expect(await day(db, "A", 800, "2026-10-03")).toBe(0);                 // 同日 retry：0 寫入
    await day(db, "A", 780, "2026-10-05");                                 // 改價（中間 10-04 冇 sync）
    await day(db, "A", 780, "2026-10-06");
    await day(db, "A", 800, "2026-10-07");                                 // 加返舊價
    expect(await rows(db)).toEqual([
      { price: 800, snapshot_date: "2026-10-01", seen_until: "2026-10-03" },
      { price: 780, snapshot_date: "2026-10-05", seen_until: "2026-10-06" },
      { price: 800, snapshot_date: "2026-10-07", seen_until: null },
    ]);
    expect(await seen(db)).toEqual([{ price: 780, last_date: "2026-10-06" }, { price: 800, last_date: "2026-10-07" }]);
    expect(w1).toBe(5);                    // 新盤：同以前一樣
    expect(w2).toBeLessThanOrEqual(2);     // 冇變價：update seen_until 1 + trigger 同步 seen 1（以前 5）
    expect(w3).toBeLessThanOrEqual(2);
  });
  it("同日改價再改返：照舊覆蓋今日嗰行", async () => {
    const db = await setup();
    await day(db, "A", 800, "2026-10-01");
    await day(db, "A", 780, "2026-10-02");
    await day(db, "A", 760, "2026-10-02");
    expect(await rows(db)).toEqual([
      { price: 800, snapshot_date: "2026-10-01", seen_until: null },
      { price: 760, snapshot_date: "2026-10-02", seen_until: null },
    ]);
    expect((await seen(db)).map((r) => r.price)).toEqual([760, 800]);     // 780 被覆蓋，seen 表都清走
  });
  it("舊每日一行數據之後接新寫法", async () => {
    const db = await setup();
    const ins = db.prepare("INSERT INTO listing_price_history (ref_no, estate_id, price, snapshot_date) VALUES ('A', 1, ?, ?)");
    await db.batch([ins.bind(800, "2026-10-01"), ins.bind(800, "2026-10-02")]);
    await day(db, "A", 800, "2026-10-03");
    expect(await rows(db)).toEqual([
      { price: 800, snapshot_date: "2026-10-01", seen_until: null },
      { price: 800, snapshot_date: "2026-10-02", seen_until: "2026-10-03" },
    ]);
  });
  it("lphRowAtSql：覆蓋 D 嗰段，否則 D 之後第一行", async () => {
    const db = await setup();
    await day(db, "A", 800, "2026-10-01"); await day(db, "A", 800, "2026-10-03");
    await day(db, "A", 780, "2026-10-08");
    const at = async (d) => (await db.prepare(`SELECT price FROM listing_price_history WHERE rowid = ${lphRowAtSql("?1", "?2")}`).bind("A", d).first())?.price ?? null;
    expect(await at("2026-10-02")).toBe(800);   // 喺 800 嗰段入面
    expect(await at("2026-10-05")).toBe(780);   // 800 段去到 10-03 為止 → 下一行
    expect(await at("2026-10-09")).toBe(null);  // 之後冇記錄（同舊寫法 MIN(snapshot_date >= D) 一樣）
  });
  it("expandPriceRuns + collapse：同每日一行摺出嚟一樣，fromDate 截頭", () => {
    const sparse = [{ snapshot_date: "2026-10-01", seen_until: "2026-10-03", price: 800, price_per_ft: 1 },
                    { snapshot_date: "2026-10-05", seen_until: null, price: 780, price_per_ft: 1 }];
    const daily = ["01", "02", "03"].map((d) => ({ snapshot_date: `2026-10-${d}`, price: 800, price_per_ft: 1 })).concat([{ snapshot_date: "2026-10-05", price: 780, price_per_ft: 1 }]);
    expect(collapsePriceHistory(expandPriceRuns(sparse))).toEqual(collapsePriceHistory(daily));
    expect(collapsePriceHistory(expandPriceRuns(sparse, "2026-10-02"))).toEqual(collapsePriceHistory(daily.slice(1)));
  });
});
