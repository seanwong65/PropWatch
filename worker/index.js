const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const CENTANET_SEARCH = "https://hk.centanet.com/findproperty/api/Post/Search";
const CENTANET_ESTATE = "https://hk.centanet.com/estate/api/Estate/Search";

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ── 抓取中原 API ──────────────────────────────────────────────
async function fetchCentanet(bigestcode) {
  const body = {
    postType: "Sale",
    sort: "Ranking",
    order: "Ascending",
    size: 100,
    offset: 0,
    displayTextStyle: "WebResultList",
    pageSource: "search",
    bigestAndEstate: [bigestcode],
    phaseAndEstate: [],
    bigPhotoMode: false,
  };

  const res = await fetch(CENTANET_SEARCH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Referer: "https://hk.centanet.com/findproperty/list/buy",
      Origin: "https://hk.centanet.com",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Centanet API error: ${res.status}`);
  return res.json();
}

// 搜尋屋苑名稱 → 取得 bigestcode
async function searchEstateName(keyword) {
  const res = await fetch(
    `${CENTANET_ESTATE}?keyword=${encodeURIComponent(keyword)}&size=10`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://hk.centanet.com/findproperty/list/buy",
      },
    }
  );
  if (!res.ok) throw new Error(`Estate search error: ${res.status}`);
  return res.json();
}

// ── 解析單位資料 ──────────────────────────────────────────────
function parseListing(item) {
  return {
    listing_id: item.id,
    ref_no: item.refNo,
    estate_name: item.bigEstateName,
    phase: item.estateName,
    building_name: item.buildingName,
    floor: item.yAxis,
    unit: item.xAxis,
    bedrooms: item.bedroomCount,
    direction: item.direction,
    size_net: item.nSize || null,
    size_gross: item.size || null,
    price: item.salePrice,
    price_per_ft: item.nUnitPrice,
    building_age: item.buildingAge,
    detail_url: item.detailUrl,
    thumbnail: item.thumbnail,
  };
}

// ── 儲存搜尋結果到 DB ─────────────────────────────────────────
async function saveSearchResults(db, estateId, listings) {
  const today = new Date().toISOString().slice(0, 10);

  for (const item of listings) {
    const l = parseListing(item);
    await db
      .prepare(
        `INSERT OR IGNORE INTO listings
         (estate_id, listing_id, ref_no, estate_name, phase, building_name,
          floor, unit, bedrooms, direction, size_net, size_gross,
          price, price_per_ft, building_age, detail_url, thumbnail, snapshot_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        estateId, l.listing_id, l.ref_no, l.estate_name, l.phase,
        l.building_name, l.floor, l.unit, l.bedrooms, l.direction,
        l.size_net, l.size_gross, l.price, l.price_per_ft,
        l.building_age, l.detail_url, l.thumbnail, today
      )
      .run();
  }

  // 計算今日快照統計
  const prices = listings.map((l) => l.nUnitPrice).filter(Boolean);
  if (prices.length > 0) {
    prices.sort((a, b) => a - b);
    const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
    const median = prices[Math.floor(prices.length / 2)];
    const allPrices = listings.map((l) => l.salePrice).filter(Boolean);
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);

    await db
      .prepare(
        `INSERT OR REPLACE INTO price_snapshots
         (estate_id, snapshot_date, avg_price_ft, median_price, min_price, max_price, listing_count)
         VALUES (?,?,?,?,?,?,?)`
      )
      .bind(estateId, today, Math.round(avg), Math.round(median), minPrice, maxPrice, listings.length)
      .run();
  }

  // 更新屋苑 last_synced
  await db
    .prepare("UPDATE estates SET last_synced = datetime('now') WHERE id = ?")
    .bind(estateId)
    .run();
}

// ── Cron: 每日重新搜尋所有已追蹤屋苑 ────────────────────────
async function runDailySync(db) {
  const { results: estates } = await db
    .prepare("SELECT * FROM estates")
    .all();

  const results = [];
  for (const estate of estates) {
    try {
      const data = await fetchCentanet(estate.bigestcode);
      const listings = data.data || [];
      await saveSearchResults(db, estate.id, listings);
      results.push({ estate: estate.name, count: listings.length, ok: true });
    } catch (err) {
      results.push({ estate: estate.name, error: err.message, ok: false });
    }
  }
  return results;
}

// ── Router ────────────────────────────────────────────────────
export default {
  // Cron Trigger (每日 UTC 1:00 = HKT 9:00)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailySync(env.DB));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const db = env.DB;

    if (method === "OPTIONS") return new Response(null, { headers: CORS });

    try {
      // GET /api/estates — 所有已追蹤屋苑
      if (method === "GET" && path === "/api/estates") {
        const { results } = await db
          .prepare(
            `SELECT e.*,
               (SELECT COUNT(*) FROM listings l WHERE l.estate_id = e.id
                AND l.snapshot_date = date('now','localtime')) AS today_count
             FROM estates e ORDER BY e.first_seen DESC`
          )
          .all();
        return json(200, { estates: results });
      }

      // POST /api/search — 搜尋屋苑名稱（autocomplete）
      if (method === "POST" && path === "/api/search") {
        const { keyword } = await request.json();
        if (!keyword?.trim()) return json(400, { error: "請輸入屋苑名稱" });

        const data = await searchEstateName(keyword.trim());
        return json(200, { results: data.data || data.estates || data || [] });
      }

      // POST /api/track — 追蹤屋苑並立即搜尋
      if (method === "POST" && path === "/api/track") {
        const { name, bigestcode, district } = await request.json();
        if (!name || !bigestcode) return json(400, { error: "缺少屋苑資料" });

        // 建立或取得屋苑記錄
        let estate = await db
          .prepare("SELECT * FROM estates WHERE bigestcode = ?")
          .bind(bigestcode)
          .first();

        if (!estate) {
          await db
            .prepare(
              "INSERT INTO estates (name, bigestcode, district) VALUES (?,?,?)"
            )
            .bind(name, bigestcode, district || null)
            .run();
          estate = await db
            .prepare("SELECT * FROM estates WHERE bigestcode = ?")
            .bind(bigestcode)
            .first();
        }

        // 立即抓取資料
        const data = await fetchCentanet(bigestcode);
        const listings = data.data || [];
        await saveSearchResults(db, estate.id, listings);

        return json(200, {
          ok: true,
          estate,
          count: listings.length,
        });
      }

      // GET /api/estates/:id/listings — 最新一批單位
      if (method === "GET" && path.match(/^\/api\/estates\/\d+\/listings$/)) {
        const estateId = path.split("/")[3];
        const date = url.searchParams.get("date") || "";
        const query = date
          ? `SELECT * FROM listings WHERE estate_id = ? AND snapshot_date = ? ORDER BY price ASC`
          : `SELECT * FROM listings WHERE estate_id = ? AND snapshot_date = (
               SELECT MAX(snapshot_date) FROM listings WHERE estate_id = ?
             ) ORDER BY price ASC`;
        const { results } = date
          ? await db.prepare(query).bind(estateId, date).all()
          : await db.prepare(query).bind(estateId, estateId).all();
        return json(200, { listings: results });
      }

      // GET /api/estates/:id/trends — 售價趨勢
      if (method === "GET" && path.match(/^\/api\/estates\/\d+\/trends$/)) {
        const estateId = path.split("/")[3];
        const { results } = await db
          .prepare(
            `SELECT snapshot_date, avg_price_ft, median_price,
                    min_price, max_price, listing_count
             FROM price_snapshots
             WHERE estate_id = ?
             ORDER BY snapshot_date ASC
             LIMIT 90`
          )
          .bind(estateId)
          .all();
        return json(200, { trends: results });
      }

      // DELETE /api/estates/:id — 刪除追蹤
      if (method === "DELETE" && path.match(/^\/api\/estates\/\d+$/)) {
        const estateId = path.split("/")[3];
        await db.prepare("DELETE FROM estates WHERE id = ?").bind(estateId).run();
        return json(200, { ok: true });
      }

      // POST /api/sync — 手動觸發同步
      if (method === "POST" && path === "/api/sync") {
        const results = await runDailySync(db);
        return json(200, { ok: true, results });
      }

      return json(404, { error: "Not found" });
    } catch (err) {
      console.error(err);
      return json(500, { error: err.message });
    }
  },
};
