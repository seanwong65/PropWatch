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

const PAGE_SIZE = 100;

async function fetchCentanetPage(estateName, offset) {
  const res = await fetch(CENTANET_SEARCH, {
    method: "POST",
    headers: FETCH_HEADERS,
    body: JSON.stringify({
      postType: "Sale",
      sort: "Ranking",
      order: "Ascending",
      size: PAGE_SIZE,
      offset,
      displayTextStyle: "WebResultList",
      pageSource: "search",
      keyword: estateName,
      bigPhotoMode: false,
    }),
    ...CF_OPTIONS,
  });
  if (!res.ok) throw new Error(`Centanet API error: ${res.status}`);
  return res.json();
}

// 用屋苑名稱 keyword 搜尋抓取所有放盤（自動分頁）
async function fetchCentanet(estateName) {
  const all = [];
  let offset = 0;
  while (true) {
    const data = await fetchCentanetPage(estateName, offset);
    const page = data.data || [];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (offset >= 500) break; // safety cap
  }
  return { data: all };
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

async function sendEmail(apiKey, to, subject, html) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "PropWatch <onboarding@resend.dev>",
      to: [to],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
  return res.json();
}

function buildEmailHtml(changes) {
  const fmt = (p) => p ? `$${(p / 1e4).toFixed(0)}萬` : "-";
  const pct = (n, o) => o ? ((n - o) / o * 100).toFixed(1) : null;

  let sections = "";

  for (const { estate, newListings, removedListings, priceChanges } of changes) {
    if (!newListings.length && !removedListings.length && !priceChanges.length) continue;

    let rows = "";

    if (priceChanges.length) {
      rows += `<tr><td colspan="4" style="padding:8px 0 4px;font-weight:700;color:#f59e0b">💰 售價變動 (${priceChanges.length})</td></tr>`;
      for (const l of priceChanges) {
        const diff = pct(l.newPrice, l.oldPrice);
        const color = diff > 0 ? "#ef4444" : "#10b981";
        rows += `<tr style="border-bottom:1px solid #1f2d42">
          <td style="padding:6px 8px">${l.building || ""} ${l.floor || ""} ${l.unit || ""}</td>
          <td style="padding:6px 8px;text-decoration:line-through;color:#64748b">${fmt(l.oldPrice)}</td>
          <td style="padding:6px 8px;font-weight:700">${fmt(l.newPrice)}</td>
          <td style="padding:6px 8px;color:${color}">${diff > 0 ? "▲" : "▼"} ${Math.abs(diff)}%</td>
        </tr>`;
      }
    }

    if (newListings.length) {
      rows += `<tr><td colspan="4" style="padding:8px 0 4px;font-weight:700;color:#10b981">🆕 新增放盤 (${newListings.length})</td></tr>`;
      for (const l of newListings) {
        rows += `<tr style="border-bottom:1px solid #1f2d42">
          <td style="padding:6px 8px">${l.building_name || ""} ${l.floor || ""} ${l.unit || ""}</td>
          <td style="padding:6px 8px;color:#64748b">${l.bedrooms ?? "-"}房 ${l.size_net ? l.size_net + "呎" : ""}</td>
          <td style="padding:6px 8px;font-weight:700;color:#f59e0b">${fmt(l.price)}</td>
          <td style="padding:6px 8px;color:#64748b">$${l.price_per_ft ? l.price_per_ft.toLocaleString() : "-"}/呎</td>
        </tr>`;
      }
    }

    if (removedListings.length) {
      rows += `<tr><td colspan="4" style="padding:8px 0 4px;font-weight:700;color:#ef4444">❌ 已下架 (${removedListings.length})</td></tr>`;
      for (const l of removedListings) {
        rows += `<tr style="border-bottom:1px solid #1f2d42">
          <td style="padding:6px 8px">${l.building_name || ""} ${l.floor || ""} ${l.unit || ""}</td>
          <td style="padding:6px 8px;color:#64748b">${l.bedrooms ?? "-"}房</td>
          <td style="padding:6px 8px;text-decoration:line-through;color:#64748b">${fmt(l.price)}</td>
          <td></td>
        </tr>`;
      }
    }

    sections += `
      <div style="margin-bottom:24px">
        <h2 style="margin:0 0 12px;font-size:18px;color:#f59e0b">${estate}</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;color:#e2e8f0">
          ${rows}
        </table>
      </div>`;
  }

  const today = new Date().toLocaleDateString("zh-HK", { timeZone: "Asia/Hong_Kong" });
  return `
    <div style="background:#0a0f1a;color:#e2e8f0;font-family:-apple-system,sans-serif;padding:24px;max-width:600px;margin:0 auto;border-radius:12px">
      <h1 style="margin:0 0 4px;font-size:22px">🏙️ PropWatch 每日通知</h1>
      <p style="margin:0 0 24px;color:#64748b;font-size:14px">${today}</p>
      ${sections}
      <p style="margin-top:24px;font-size:12px;color:#64748b">
        <a href="https://propwatch.pages.dev" style="color:#3b82f6">前往 PropWatch</a>
      </p>
    </div>`;
}

async function detectChanges(db, estateId, estateName, newListings) {
  const today = new Date().toISOString().slice(0, 10);

  // Get yesterday's listings
  const { results: oldRows } = await db
    .prepare(
      `SELECT ref_no, building_name, floor, unit, bedrooms, price, size_net
       FROM listings WHERE estate_id = ? AND snapshot_date = (
         SELECT MAX(snapshot_date) FROM listings
         WHERE estate_id = ? AND snapshot_date < ?
       )`
    )
    .bind(estateId, estateId, today)
    .all();

  const oldMap = new Map(oldRows.map(r => [r.ref_no, r]));
  const newMap = new Map(
    newListings
      .filter(l => l.refNo)
      .map(l => [l.refNo, {
        ref_no: l.refNo,
        building_name: l.buildingName,
        floor: l.yAxis,
        unit: l.xAxis,
        bedrooms: l.bedroomCount,
        price: l.salePrice,
        size_net: l.nSize,
        price_per_ft: l.nUnitPrice,
      }])
  );

  const priceChanges = [];
  const newAdded = [];
  const removed = [];

  for (const [ref, nl] of newMap) {
    if (!oldMap.has(ref)) {
      newAdded.push(nl);
    } else {
      const ol = oldMap.get(ref);
      if (ol.price && nl.price && Math.abs(nl.price - ol.price) > 1000) {
        priceChanges.push({ ...nl, oldPrice: ol.price, newPrice: nl.price, building: nl.building_name });
      }
    }
  }

  for (const [ref, ol] of oldMap) {
    if (!newMap.has(ref)) removed.push(ol);
  }

  return { estate: estateName, priceChanges, newListings: newAdded, removedListings: removed };
}

async function runDailySync(db, resendApiKey) {
  const { results: estates } = await db.prepare("SELECT * FROM estates").all();
  const results = await Promise.all(
    estates.map(async (estate) => {
      try {
        const data = await fetchCentanet(estate.name);
        const listings = data.data || [];
        const changes = await detectChanges(db, estate.id, estate.name, listings);
        await saveSearchResults(db, estate.id, listings);
        return { estate: estate.name, count: listings.length, ok: true, changes };
      } catch (err) {
        return { estate: estate.name, error: err.message, ok: false };
      }
    })
  );

  // Send email if there are any changes
  if (resendApiKey) {
    const allChanges = results.filter(r => r.ok && r.changes).map(r => r.changes);
    const hasChanges = allChanges.some(
      c => c.priceChanges.length || c.newListings.length || c.removedListings.length
    );
    if (hasChanges) {
      const totalPrice = allChanges.reduce((s, c) => s + c.priceChanges.length, 0);
      const totalNew   = allChanges.reduce((s, c) => s + c.newListings.length, 0);
      const totalDel   = allChanges.reduce((s, c) => s + c.removedListings.length, 0);
      const parts = [];
      if (totalPrice) parts.push(`${totalPrice} 個價格變動`);
      if (totalNew)   parts.push(`${totalNew} 個新放盤`);
      if (totalDel)   parts.push(`${totalDel} 個已下架`);
      await sendEmail(
        resendApiKey,
        "johnwong777@hotmail.com",
        `PropWatch 通知：${parts.join("、")}`,
        buildEmailHtml(allChanges)
      );
    }
  }

  return results;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailySync(env.DB, env.RESEND_API_KEY));
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
             FROM estates e ORDER BY e.is_favourite DESC, e.sort_order ASC`
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

      if (method === "POST" && path.match(/^\/api\/estates\/\d+\/favourite$/)) {
        const estateId = path.split("/")[3];
        const estate = await db.prepare("SELECT is_favourite FROM estates WHERE id = ?").bind(estateId).first();
        if (!estate) return json(404, { error: "Not found" });
        const newVal = estate.is_favourite ? 0 : 1;
        await db.prepare("UPDATE estates SET is_favourite = ? WHERE id = ?").bind(newVal, estateId).run();
        return json(200, { ok: true, is_favourite: newVal });
      }

      if (method === "POST" && path === "/api/estates/reorder") {
        const { order } = await request.json();
        const stmt = db.prepare("UPDATE estates SET sort_order = ? WHERE id = ?");
        await db.batch(order.map(({ id, sort_order }) => stmt.bind(sort_order, id)));
        return json(200, { ok: true });
      }

      if (method === "DELETE" && path.match(/^\/api\/estates\/\d+$/)) {
        const estateId = path.split("/")[3];
        await db.prepare("DELETE FROM estates WHERE id = ?").bind(estateId).run();
        return json(200, { ok: true });
      }

      if (method === "POST" && path === "/api/sync") {
        const results = await runDailySync(db, env.RESEND_API_KEY);
        return json(200, { ok: true, results });
      }

      if (method === "POST" && path === "/api/test-email") {
        await sendEmail(
          env.RESEND_API_KEY,
          "johnwong777@hotmail.com",
          "PropWatch 測試郵件",
          buildEmailHtml([{
            estate: "測試屋苑",
            priceChanges: [{ building: "A座", floor: "高層", unit: "1室", oldPrice: 5000000, newPrice: 5500000 }],
            newListings: [{ building_name: "B座", floor: "中層", unit: "2室", bedrooms: 2, size_net: 500, price: 6000000, price_per_ft: 12000 }],
            removedListings: [{ building_name: "C座", floor: "低層", unit: "3室", bedrooms: 3, price: 7000000 }],
          }])
        );
        return json(200, { ok: true, message: "測試郵件已發送至 johnwong777@hotmail.com" });
      }

      return json(404, { error: "Not found" });
    } catch (err) {
      console.error(err);
      return json(500, { error: err.message });
    }
  },
};
