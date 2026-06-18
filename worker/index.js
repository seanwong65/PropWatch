const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const CENTANET_SEARCH = "https://hk.centanet.com/findproperty/api/Post/Search";

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

const FETCH_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Referer": "https://hk.centanet.com/findproperty/list/buy",
  "Origin": "https://hk.centanet.com",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-HK,zh;q=0.9,en;q=0.8",
  "sec-ch-ua": '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

// Cloudflare cf 選項：偽裝成香港用戶請求
const CF_OPTIONS = {
  cf: {
    country: "HK",
    resolveOverride: "hk.centanet.com",
    cacheTtl: 0,
    cacheEverything: false,
  },
};

function getEstateCode(item) {
  return item.bigestcode || item.cestcode || "";
}

function getEstateName(item) {
  return item.bigEstateName || item.estateName || "";
}

// 用屋苑名稱 keyword 搜尋抓取放盤（適用所有屋苑）
async function fetchCentanet(estateName) {
  const body = {
    postType: "Sale",
    sort: "Ranking",
    order: "Ascending",
    size: 100,
    offset: 0,
    displayTextStyle: "WebResultList",
    pageSource: "search",
    keyword: estateName,
    bigPhotoMode: false,
  };

  const res = await fetch(CENTANET_SEARCH, {
    method: "POST",
    headers: FETCH_HEADERS,
    body: JSON.stringify(body),
    ...CF_OPTIONS,
  });

  console.log("[fetchCentanet] status:", res.status, "estate:", estateName);
  if (!res.ok) throw new Error(`Centanet API error: ${res.status}`);
  return res.json();
}

// 搜尋屋苑名稱，返回獨特屋苑列表（支援大型屋苑群同單一屋苑）
async function searchEstateName(keyword) {
  const body = {
    postType: "Sale",
    sort: "Ranking",
    order: "Ascending",
    size: 24,
    offset: 0,
    displayTextStyle: "WebResultList",
    pageSource: "search",
    keyword: keyword,
    bigPhotoMode: false,
  };

  const res = await fetch(CENTANET_SEARCH, {
    method: "POST",
    headers: FETCH_HEADERS,
    body: JSON.stringify(body),
    ...CF_OPTIONS,
  });

  console.log("[searchEstateName] status:", res.status, "keyword:", keyword);
  const rawText = await res.text();
  console.log("[searchEstateName] response preview:", rawText.slice(0, 300));

  if (!res.ok) throw new Error(`Search error: ${res.status}`);
  const data = JSON.parse(rawText);

  const seen = new Set();
  const estates = [];
  for (const item of (data.data || [])) {
    const code = getEstateCode(item);
    const name = getEstateName(item);
    if (code && name && !seen.has(code)) {
      seen.add(code);
      estates.push({
        bigEstateName: name,
        bigestcode: code,
        isBigest: !!item.bigestcode,
        districtName: item.districtName || item.scope?.hma || "",
      });
    }
  }
  return { estates };
}

const N = (v) => (v == null ? null : v);

function parseListing(item) {
  return {
    listing_id: item.id,
    ref_no: N(item.refNo),
    estate_name: getEstateName(item),
    phase: item.estateName !== getEstateName(item) ? item.estateName : "",
    building_name: N(item.buildingName),
    floor: N(item.yAxis),
    unit: N(item.xAxis),
    bedrooms: N(item.bedroomCount),
    direction: N(item.direction),
    size_net: item.nSize || null,
    size_gross: item.size || null,
    price: item.salePrice,
    price_per_ft: N(item.nUnitPrice),
    building_age: N(item.buildingAge),
    detail_url: N(item.detailUrl),
    thumbnail: N(item.thumbnail),
  };
}

async function saveSearchResults(db, estateId, listings) {
  const today = new Date().toISOString().slice(0, 10);

  const stmtListing = db.prepare(
    `INSERT OR IGNORE INTO listings
     (estate_id, listing_id, ref_no, estate_name, phase, building_name,
      floor, unit, bedrooms, direction, size_net, size_gross,
      price, price_per_ft, building_age, detail_url, thumbnail, snapshot_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const stmtHistory = db.prepare(
    `INSERT OR IGNORE INTO listing_price_history (ref_no, estate_id, price, price_per_ft, snapshot_date)
     VALUES (?,?,?,?,?)`
  );

  const batch = [];
  for (const item of listings) {
    const l = parseListing(item);
    batch.push(
      stmtListing.bind(
        estateId, l.listing_id, l.ref_no, l.estate_name, l.phase,
        l.building_name, l.floor, l.unit, l.bedrooms, l.direction,
        l.size_net, l.size_gross, l.price, l.price_per_ft,
        l.building_age, l.detail_url, l.thumbnail, today
      )
    );
    if (l.ref_no && l.price) {
      batch.push(stmtHistory.bind(l.ref_no, estateId, l.price, l.price_per_ft, today));
    }
  }
  if (batch.length > 0) await db.batch(batch);

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

  await db
    .prepare("UPDATE estates SET last_synced = datetime('now') WHERE id = ?")
    .bind(estateId)
    .run();
}

async function runDailySync(db) {
  const { results: estates } = await db.prepare("SELECT * FROM estates").all();
  return Promise.all(
    estates.map(async (estate) => {
      try {
        const data = await fetchCentanet(estate.name);
        const listings = data.data || [];
        await saveSearchResults(db, estate.id, listings);
        return { estate: estate.name, count: listings.length, ok: true };
      } catch (err) {
        return { estate: estate.name, error: err.message, ok: false };
      }
    })
  );
}

export default {
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

      if (method === "POST" && path === "/api/search") {
        const { keyword } = await request.json();
        if (!keyword?.trim()) return json(400, { error: "請輸入屋苑名稱" });
        const data = await searchEstateName(keyword.trim());
        return json(200, { results: data.estates || [] });
      }

      if (method === "POST" && path === "/api/track") {
        const { name, bigestcode, district, isBigest } = await request.json();
        if (!name || !bigestcode) return json(400, { error: "缺少屋苑資料" });

        let estate = await db
          .prepare("SELECT * FROM estates WHERE bigestcode = ?")
          .bind(bigestcode)
          .first();

        const useBigest = isBigest !== false;

        if (!estate) {
          await db
            .prepare("INSERT INTO estates (name, bigestcode, district, is_bigest) VALUES (?,?,?,?)")
            .bind(name, bigestcode, district || null, useBigest ? 1 : 0)
            .run();
          estate = await db
            .prepare("SELECT * FROM estates WHERE bigestcode = ?")
            .bind(bigestcode)
            .first();
        }
        const data = await fetchCentanet(name);
        const listings = data.data || [];
        await saveSearchResults(db, estate.id, listings);

        return json(200, { ok: true, estate, count: listings.length });
      }

      if (method === "GET" && path.match(/^\/api\/estates\/\d+\/listings$/)) {
        const estateId = path.split("/")[3];
        const { results } = await db
          .prepare(
            `SELECT l.*,
               prev.price AS prev_price,
               prev.price_per_ft AS prev_price_per_ft
             FROM listings l
             LEFT JOIN listing_price_history prev
               ON prev.ref_no = l.ref_no
               AND prev.snapshot_date = (
                 SELECT MAX(snapshot_date) FROM listing_price_history
                 WHERE ref_no = l.ref_no AND snapshot_date < l.snapshot_date
               )
             WHERE l.estate_id = ? AND l.snapshot_date = (
               SELECT MAX(snapshot_date) FROM listings WHERE estate_id = ?
             )
             ORDER BY l.price ASC`
          )
          .bind(estateId, estateId)
          .all();
        return json(200, { listings: results });
      }

      if (method === "GET" && path.match(/^\/api\/listings\/.+\/history$/)) {
        const refNo = decodeURIComponent(path.split("/")[3]);
        const { results } = await db
          .prepare(
            `SELECT snapshot_date, price, price_per_ft
             FROM listing_price_history
             WHERE ref_no = ?
             ORDER BY snapshot_date ASC`
          )
          .bind(refNo)
          .all();
        return json(200, { history: results });
      }

      if (method === "GET" && path.match(/^\/api\/estates\/\d+\/trends$/)) {
        const estateId = path.split("/")[3];
        const { results } = await db
          .prepare(
            `SELECT snapshot_date, avg_price_ft, median_price,
                    min_price, max_price, listing_count
             FROM price_snapshots WHERE estate_id = ?
             ORDER BY snapshot_date ASC LIMIT 90`
          )
          .bind(estateId)
          .all();
        return json(200, { trends: results });
      }

      if (method === "GET" && path.match(/^\/api\/debug\/.+$/)) {
        const name = decodeURIComponent(path.split("/")[3]);
        const raw = await fetchCentanet(name);
        return json(200, { count: raw.data?.length ?? 0, name, sample: raw.data?.slice(0, 1) });
      }

      if (method === "DELETE" && path.match(/^\/api\/estates\/\d+$/)) {
        const estateId = path.split("/")[3];
        await db.prepare("DELETE FROM estates WHERE id = ?").bind(estateId).run();
        return json(200, { ok: true });
      }

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
