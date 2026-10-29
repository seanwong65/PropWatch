// newTxnsOnly（2026-10-29）：成交入庫前先剔走已有嘅，慳 D1 寫入。
// 要證明：剔走嘅一定係 DB 本身都會 IGNORE（或者 dropShadowTxns 會刪）嘅，真係新嘅一宗都唔會漏。
import { describe, it, expect, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { newTxnsOnly } from "../index.js";

const mf = new Miniflare({ modules: true, script: "export default { fetch(){ return new Response('x') } }", d1Databases: ["DB"] });
afterAll(() => mf.dispose());
const COLS = "estate_id, transaction_id, building, bldg_key, floor, unit, price, reg_date, first_seen";
async function setup() {
  const db = await mf.getD1Database("DB");
  await db.prepare("DROP TABLE IF EXISTS transactions").run();
  await db.prepare(`CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, estate_id INTEGER NOT NULL, transaction_id TEXT NOT NULL,
    building TEXT, bldg_key TEXT, floor TEXT, unit TEXT, price REAL, reg_date TEXT, first_seen TEXT, UNIQUE(transaction_id))`).run();
  await db.prepare(`CREATE UNIQUE INDEX idx_txn_combo ON transactions (estate_id, COALESCE(bldg_key,''), COALESCE(floor,''), COALESCE(unit,''), COALESCE(price,-1), COALESCE(reg_date,''))`).run();
  const ins = db.prepare(`INSERT INTO transactions (${COLS}) VALUES (?,?,?,?,?,?,?,?,?)`);
  await db.batch([
    ins.bind(1, "c1", "8座", "8", "10", "A", 6800000, "2026-09-01", "2026-09-02"),
    ins.bind(1, "c2", "3座", "3", "5", "B", 5000000, "2026-09-03", "2026-09-04"),
    ins.bind(2, "x9", "1座", "1", "1", "A", 1000000, "2026-09-01", "2026-09-02"),   // 第二個屋苑，唔應該影響屋苑 1
  ]);
  return db;
}
const row = (id, building, bldg_key, floor, unit, price, reg_date) => ({ transaction_id: id, building, bldg_key, floor, unit, price, reg_date,
  args: [1, id, building, bldg_key, floor, unit, price, reg_date, "2026-10-29"] });

describe("newTxnsOnly", () => {
  it("剔走同 id／同 combo／影子；新成交全部保留，結果同 INSERT OR IGNORE 一致", async () => {
    const db = await setup();
    const rows = [
      row("c1", "8座", "8", "10", "A", 6800000, "2026-09-01"),            // 同 id → 剔
      row("r1", "08座", "8", "10", "A", 6800000, "2026-09-01"),           // 唔同 id 同 combo（08座 → bldg_key 8）→ 剔
      row("t1", "8座", "8", 10, "A", 6800000, "2026-09-01"),              // 樓層係 JS 數字（DB 會存 '10.0'）→ 唔剔，交返 DB
      row("r2", null, "", "5", "B", 5000000, "2026-09-03"),               // 影子（冇座數）→ 剔
      row("r3", null, "", "7", "C", 4000000, "2026-09-05"),               // 冇座數但冇對應 → 保留
      row("n1", "8座", "8", "11", "A", 6900000, "2026-10-20"),            // 新 → 保留
      row("n2", "1座", "1", "1", "A", 1000000, "2026-09-01"),             // 屋苑 2 有同 combo，但屋苑 1 冇 → 保留
    ];
    const kept = await newTxnsOnly(db, "transactions", 1, rows);
    expect(kept.map((r) => r.transaction_id)).toEqual(["t1", "r3", "n1", "n2"]);
    // 對照：全部 INSERT OR IGNORE，DB 真正 insert 到嘅（扣除影子）應該同 kept 一樣
    const st = db.prepare(`INSERT OR IGNORE INTO transactions (${COLS}) VALUES (?,?,?,?,?,?,?,?,?)`);
    await db.batch(rows.map((r) => st.bind(...r.args)));
    const { results } = await db.prepare("SELECT transaction_id FROM transactions WHERE estate_id = 1 AND first_seen = '2026-10-29' ORDER BY transaction_id").all();
    expect(results.map((r) => r.transaction_id).filter((id) => id !== "r2" && id !== "t1")).toEqual(["n1", "n2", "r3"]);
  });
  it("rental 表唔用 id 比對（冇 UNIQUE(transaction_id)）", async () => {
    const db = await mf.getD1Database("DB");
    await db.prepare("DROP TABLE IF EXISTS rental_transactions").run();
    await db.prepare(`CREATE TABLE rental_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, estate_id INTEGER, transaction_id TEXT, building TEXT, bldg_key TEXT, floor TEXT, unit TEXT, price REAL, reg_date TEXT)`).run();
    await db.prepare("INSERT INTO rental_transactions (estate_id, transaction_id, building, bldg_key, floor, unit, price, reg_date) VALUES (1,'z','1座','1','3','A',20000,'2026-10-01')").run();
    const kept = await newTxnsOnly(db, "rental_transactions", 1, [
      row("z", "1座", "1", "3", "A", 21000, "2026-10-02"),   // 同 id 但唔同 combo → 保留
      row("y", "1座", "1", "3", "A", 20000, "2026-10-01"),   // 同 combo → 剔
    ]);
    expect(kept.map((r) => r.transaction_id)).toEqual(["z"]);
  });
  it("空 list 唔查 DB", async () => {
    expect(await newTxnsOnly(null, "transactions", 1, [])).toEqual([]);
  });
});
