// 主頁「你嘅屋苑今日」（2026-11-01）：每個屋苑預先計最新 sync 日嘅新盤／減價／加價／新成交。
// 純計算 + 用 Miniflare（同 D1 一樣嘅 SQLite）行真 SQL。
import { describe, it, expect, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { dayChangesFrom, computeDayChanges } from "../estateStats.js";

const SOURCES = ["centanet", "midland", "hkp", "ricacorp"];

describe("dayChangesFrom", () => {
  it("冇對上價錢＝新盤；差 > $1,000 先算減價／加價", () => {
    expect(dayChangesFrom([
      { p: 600e4, prev: null },
      { p: 580e4, prev: 600e4 },     // 減 20 萬
      { p: 620e4, prev: 600e4 },     // 加 20 萬
      { p: 600e4, prev: 600.05e4 },  // 差 $500：當冇變（同今日動態一致）
    ])).toEqual({ new: 1, cuts: 1, ups: 1 });
    expect(dayChangesFrom([])).toEqual({ new: 0, cuts: 0, ups: 0 });
  });
});

const mf = new Miniflare({ modules: true, script: "export default { fetch(){ return new Response('x') } }", d1Databases: ["DB"] });
afterAll(() => mf.dispose());
async function setup() {
  const db = await mf.getD1Database("DB");
  for (const t of ["estates", "listings", "listing_price_history", "transactions"]) await db.prepare(`DROP TABLE IF EXISTS ${t}`).run();
  await db.prepare("CREATE TABLE estates (id INTEGER PRIMARY KEY, first_seen TEXT)").run();
  await db.prepare("CREATE TABLE listings (id INTEGER PRIMARY KEY, estate_id INTEGER, source TEXT, ref_no TEXT, price REAL, snapshot_date TEXT)").run();
  await db.prepare("CREATE INDEX idx_listings_estate_src_date ON listings(estate_id, source, snapshot_date)").run();
  await db.prepare(`CREATE TABLE listing_price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ref_no TEXT NOT NULL, estate_id INTEGER NOT NULL,
    price REAL NOT NULL, snapshot_date TEXT NOT NULL, seen_until TEXT, UNIQUE(ref_no, snapshot_date))`).run();
  await db.prepare("CREATE INDEX idx_lph_ref ON listing_price_history(ref_no, snapshot_date DESC)").run();
  await db.prepare("CREATE TABLE transactions (id INTEGER PRIMARY KEY, estate_id INTEGER, first_seen TEXT, reg_date TEXT)").run();
  await db.prepare("CREATE INDEX idx_txn_estate ON transactions(estate_id, first_seen DESC)").run();
  return db;
}
const ins = (db, sql, ...a) => db.prepare(sql).bind(...a).run();

describe("computeDayChanges", () => {
  it("新盤／減價／加價／冇變／其他屋苑／新成交（登記日 90 日內）", async () => {
    const db = await setup();
    const D = "2026-11-01";
    await ins(db, "INSERT INTO estates VALUES (1, '2026-10-01 06:00:00'), (2, '2026-10-01 06:00:00')");
    // 盤 N：今日先出現（新盤）；C：減價；U：加價；S：價錢冇變（lph 稀疏，今日冇新行）
    for (const [ref, p] of [["N", 500e4], ["C", 580e4], ["U", 620e4], ["S", 700e4]]) await ins(db, "INSERT INTO listings (estate_id, source, ref_no, price, snapshot_date) VALUES (1, 'centanet', ?, ?, ?)", ref, p, D);
    await ins(db, "INSERT INTO listings (estate_id, source, ref_no, price, snapshot_date) VALUES (2, 'midland', 'X', 1, ?)", D);   // 第二個屋苑唔計
    for (const [ref, p, d] of [["C", 600e4, "2026-10-20"], ["C", 580e4, D], ["U", 600e4, "2026-10-25"], ["U", 620e4, D],
      ["S", 700e4, "2026-10-10"], ["N", 500e4, D], ["X", 1, D]]) await ins(db, "INSERT INTO listing_price_history (ref_no, estate_id, price, snapshot_date) VALUES (?, ?, ?, ?)", ref, ref === "X" ? 2 : 1, p, d);
    for (const [fs, rd] of [[D, "2026-10-20"], [D, "2026-06-01"], ["2026-10-31", "2026-10-28"]]) await ins(db, "INSERT INTO transactions (estate_id, first_seen, reg_date) VALUES (1, ?, ?)", fs, rd);
    expect(await computeDayChanges(db, 1, D, SOURCES)).toEqual({ day: D, new: 1, cuts: 1, ups: 1, txns: 1 });
  });
  it("屋苑第一次 sync 未夠兩日 → null（唔好將全部盤當新盤）", async () => {
    const db = await setup();
    await ins(db, "INSERT INTO estates VALUES (1, '2026-10-31 06:00:00')");
    expect(await computeDayChanges(db, 1, "2026-11-01", SOURCES)).toBeNull();
    expect(await computeDayChanges(db, 99, "2026-11-01", SOURCES)).toBeNull();
  });
});
