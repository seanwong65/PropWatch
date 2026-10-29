// 新屋苑每日名額（sec_onboard_per_day，2026-10-29）：從未 sync 過嘅屋苑每個 UTC 日只放行 N 個，餘下排隊。
import { describe, it, expect, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { planOnboarding, claimOnboardSlot, readOnboard, onboardQueue, getDailySyncEstateIds } from "../index.js";

describe("planOnboarding（純函數）", () => {
  it("名額夠就按 id 先後放行，餘下排隊", () => {
    expect(planOnboarding({ never: [9, 3, 5], granted: [], cap: 1 })).toEqual({ grant: [3], queued: [5, 9] });
    expect(planOnboarding({ never: [9, 3, 5], granted: [], cap: 2 })).toEqual({ grant: [3, 5], queued: [9] });
  });
  it("今日已放行嘅計入名額，唔會再補", () => {
    expect(planOnboarding({ never: [3, 5], granted: [3], cap: 1 })).toEqual({ grant: [], queued: [5] });
    expect(planOnboarding({ never: [5], granted: [3, 4], cap: 2 })).toEqual({ grant: [], queued: [5] });
  });
  it("冇排隊／冇人", () => {
    expect(planOnboarding({ never: [], granted: [], cap: 1 })).toEqual({ grant: [], queued: [] });
  });
});

const mf = new Miniflare({ modules: true, script: "export default { fetch(){ return new Response('x') } }", d1Databases: ["DB"] });
afterAll(() => mf.dispose());
async function fresh() {
  const db = await mf.getD1Database("DB");
  for (const t of ["settings", "estates", "account_estates", "sync_log"]) await db.prepare(`DROP TABLE IF EXISTS ${t}`).run();
  await db.prepare("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)").run();
  await db.prepare("CREATE TABLE estates (id INTEGER PRIMARY KEY, name TEXT, is_disabled INTEGER DEFAULT 0)").run();
  await db.prepare("DROP TABLE IF EXISTS accounts").run();
  await db.prepare("CREATE TABLE accounts (id INTEGER PRIMARY KEY, tier TEXT, role TEXT, is_active INTEGER)").run();
  await db.prepare("INSERT INTO accounts VALUES (1,'paid','user',1)").run();
  await db.prepare("CREATE TABLE account_estates (account_id INTEGER, estate_id INTEGER, paused_at TEXT, is_favourite INTEGER DEFAULT 0)").run();
  await db.prepare("CREATE TABLE sync_log (estate_id INTEGER, source TEXT, kind TEXT, sync_date TEXT, ok INTEGER)").run();
  return db;
}
describe("claimOnboardSlot（D1）", () => {
  it("預設每日 1 個：同一個再問仍然得；第二個被擋；admin force 放行但照計數", async () => {
    const db = await fresh();
    expect(await claimOnboardSlot(db, 10)).toBe(true);
    expect(await claimOnboardSlot(db, 10)).toBe(true);        // 同一個屋苑重複問（例如第二個用戶加同一個）
    expect(await claimOnboardSlot(db, 11)).toBe(false);
    expect(await claimOnboardSlot(db, 12, { force: true })).toBe(true);
    expect((await readOnboard(db)).ids.map((x) => x.id)).toEqual([10, 12]);
    expect(await claimOnboardSlot(db, 13)).toBe(false);       // admin 嗰個照計數，之後嘅普通用戶更加冇位
  });
  it("UTC 日一轉就重置", async () => {
    const db = await fresh();
    await claimOnboardSlot(db, 10);
    await db.prepare("UPDATE settings SET value = json_set(value, '$.day', '2000-01-01') WHERE key = 'onboard_slots'").run();
    expect((await readOnboard(db)).ids).toEqual([]);
    expect(await claimOnboardSlot(db, 11)).toBe(true);
  });
  it("onboardQueue：生效 + 從未 sync 成功 + 未放行", async () => {
    const db = await fresh();
    await db.batch([
      db.prepare("INSERT INTO estates (id, name, is_disabled) VALUES (1,'舊',0),(2,'新A',0),(3,'新B',0),(4,'停用',1),(5,'冇人追蹤',0)"),
      db.prepare("INSERT INTO account_estates (account_id, estate_id, paused_at) VALUES (1,1,NULL),(1,2,NULL),(1,3,NULL),(1,4,NULL)"),
      db.prepare("INSERT INTO sync_log VALUES (1,'centanet','listings','2026-10-28',1)"),
    ]);
    expect(await onboardQueue(db)).toEqual([2, 3]);
    await claimOnboardSlot(db, 2);
    expect(await onboardQueue(db)).toEqual([3]);
  });
});

describe("getDailySyncEstateIds（drip 計劃）", () => {
  it("新屋苑（最愛都一樣）唔跟日常計劃，只按名額放行；放行後同日一直入計劃", async () => {
    const db = await fresh();
    await db.batch([
      db.prepare("INSERT INTO account_estates (account_id, estate_id, paused_at, is_favourite) VALUES (1,1,NULL,1),(1,7,NULL,1),(1,8,NULL,0)"),
      db.prepare("INSERT INTO sync_log VALUES (1,'centanet','listings','2026-10-20',1)"),
      db.prepare("INSERT INTO estates (id, name) VALUES (1,'舊'),(7,'新屋苑7'),(8,'新屋苑8')"),
    ]);
    const today = "2026-10-29";
    const never = new Map([[7, "新屋苑7"], [8, "新屋苑8"]]);
    const ids = await getDailySyncEstateIds(db, today, [1, 7, 8], never);
    expect([...ids].sort()).toEqual([1, 7]);                 // 1＝舊最愛；7＝按 id 先放行；8 排隊（就算 7 係最愛）
    const again = await getDailySyncEstateIds(db, today, [1, 7, 8], never);
    expect([...again].sort()).toEqual([1, 7]);               // 再計都唔會多放一個
    const after = await getDailySyncEstateIds(db, today, [1, 7, 8], new Map([[8, "新屋苑8"]]));   // 7 已 sync 咗（唔再係 never）
    expect([...after].sort()).toEqual([1, 7]);               // 但今日放行嘅仲喺入面，剩餘單元照做
    expect(await onboardQueue(db)).toEqual([8]);             // 8 仲排緊隊（明日額度日先補位）
  });
});
