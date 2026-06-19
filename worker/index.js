const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const CENTANET_SEARCH = "https://hk.centanet.com/findproperty/api/Post/Search";
const CENTANET_TRANS  = "https://hk.centanet.com/findproperty/api/Transaction/Search";
const HS_API = "https://rbwm-api.hsbc.com.hk/pws-hk-hase-mortgage-eapi-prod-proxy/v1/property";
const HS_HEADERS = {
  "Content-Type": "application/json",
  "Referer": "https://www.hangseng.com/zh-hk/e-valuation/address-search/",
  "Origin": "https://www.hangseng.com",
  "Accept": "application/json",
};

// In-memory cache (per Worker instance lifetime)
let hsBlockListCache = null;
const hsEstateCache = new Map();

async function hsKeywordSearch(estateName) {
  if (hsEstateCache.has(estateName)) return hsEstateCache.get(estateName);
  const res = await fetch(`${HS_API}/keywordsearch?keyword=${encodeURIComponent(estateName)}`, { headers: HS_HEADERS });
  if (!res.ok) return null;
  const data = await res.json();
  const match = Array.isArray(data) ? data[0] : null;
  if (match) hsEstateCache.set(estateName, match);
  return match;
}

async function hsBlockList() {
  if (hsBlockListCache) return hsBlockListCache;
  const res = await fetch(`${HS_API}/area2blockfulllist`, { headers: HS_HEADERS });
  if (!res.ok) return null;
  hsBlockListCache = await res.json();
  return hsBlockListCache;
}

async function findBlockCode(estateCode, blockNum) {
  const list = await hsBlockList();
  if (!list) return null;
  for (const area of list.areas || []) {
    for (const dist of area.districts || []) {
      for (const estate of dist.estates || []) {
        if (estate.estateCode === String(estateCode)) {
          const block = estate.blocks?.find(b =>
            b.blockChinesename === `第${blockNum}座` ||
            b.blockChinesename?.includes(`第${blockNum}座`) ||
            b.blockName === `Block/Tower ${blockNum}`
          );
          return block ? { blockCode: block.blockCode, carpark: block.coveredCarpark || "0" } : null;
        }
      }
    }
  }
  return null;
}

async function getHangSengValuation(estateName, blockNum, floorNum, flatLetter) {
  const estate = await hsKeywordSearch(estateName);
  if (!estate) return null;
  const blockInfo = await findBlockCode(estate.estateCode, blockNum);
  if (!blockInfo) return null;
  const body = {
    area: String(estate.areaCode),
    district: String(estate.districtCode),
    estate: String(estate.estateCode),
    block: String(blockInfo.blockCode),
    floor: String(floorNum),
    flat: String(flatLetter),
    carpark: 0,
    tcKnowledge: "on",
    openCarpark: 0,
  };
  const res = await fetch(`${HS_API}/valuation`, { method: "POST", headers: HS_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) return null;
  const data = await res.json();
  const result = Array.isArray(data) ? data[0] : data;
  if (result?.errorCode || result?.fieldName) return null;
  return { price: result.price, saleableArea: result.saleableArea, valuationDate: result.valuationDate };
}

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
    .prepare("UPDATE estates SET last_synced = datetime('now', '+8 hours') WHERE id = ?")
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

  for (const { estate, newListings, removedListings, priceChanges, newTransactions = [] } of changes) {
    if (!newListings.length && !removedListings.length && !priceChanges.length && !newTransactions.length) continue;

    let rows = "";

    if (newTransactions.length) {
      rows += `<tr><td colspan="4" style="padding:8px 0 4px;font-weight:700;color:#a78bfa">🏠 新成交記錄 (${newTransactions.length})</td></tr>`;
      for (const t of newTransactions) {
        const gainColor = t.gain_pct > 0 ? "#10b981" : t.gain_pct < 0 ? "#ef4444" : "#64748b";
        const gainStr = t.gain_pct != null ? `${t.gain_pct > 0 ? "▲" : "▼"} ${Math.abs(t.gain_pct).toFixed(1)}%` : "-";
        rows += `<tr style="border-bottom:1px solid #1f2d42">
          <td style="padding:6px 8px">${t.building || ""} ${t.floor || ""} ${t.unit || ""}</td>
          <td style="padding:6px 8px;color:#64748b">${t.size_net ? t.size_net + "實呎" : ""}</td>
          <td style="padding:6px 8px;font-weight:700;color:#f59e0b">${t.price ? `$${(t.price / 1e4).toFixed(0)}萬` : "-"}</td>
          <td style="padding:6px 8px;color:${gainColor}">${gainStr}</td>
        </tr>`;
      }
    }

    if (priceChanges.length) {
      rows += `<tr><td colspan="4" style="padding:8px 0 4px;font-weight:700;color:#f59e0b">💰 售價變動 (${priceChanges.length})</td></tr>`;
      for (const l of priceChanges) {
        const diff = pct(l.newPrice, l.oldPrice);
        rows += `<tr style="border-bottom:1px solid #1f2d42">
          <td style="padding:6px 8px">${l.building || ""} ${l.floor || ""} ${l.unit || ""}</td>
          <td style="padding:6px 8px;text-decoration:line-through;color:#64748b">${fmt(l.oldPrice)}</td>
          <td style="padding:6px 8px;font-weight:700">${fmt(l.newPrice)}</td>
          <td style="padding:6px 8px;color:${diff > 0 ? "#10b981" : "#ef4444"}">${diff > 0 ? "▲" : "▼"} ${Math.abs(diff)}%</td>
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

async function fetchNewTransactions(estateName) {
  const res = await fetch(CENTANET_TRANS, {
    method: "POST",
    headers: FETCH_HEADERS,
    body: JSON.stringify({ postType: "Sale", size: 50, offset: 0, keyword: estateName }),
    ...CF_OPTIONS,
  });
  if (!res.ok) return [];
  const raw = await res.json();
  const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return (raw.data || [])
    .filter(t => t.regDate && t.regDate.slice(0, 10) >= yesterday)
    .map(t => ({
      building: t.buildingName,
      floor: t.yAxis,
      unit: t.xAxis,
      price: t.transactionPrice,
      size_net: t.nArea,
      price_per_ft: t.nUnitPrice,
      reg_date: t.regDate?.slice(0, 10),
      prev_price: t.prevTransactionPrice,
      gain_pct: t.gainPercent,
      held_days: t.heldDay,
    }));
}

async function detectChanges(db, estateId, estateName, newListings) {
  const todayHK = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const today = todayHK;

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

  // Only flag as new if first seen today (HK time) — avoids showing stale listings from previous days
  const { results: todayFirstSeen } = await db
    .prepare(`SELECT listing_id FROM listings WHERE estate_id=? AND date(snapshot_date)=? AND listing_id NOT IN (SELECT listing_id FROM listings WHERE estate_id=? AND date(snapshot_date)<?)`)
    .bind(estateId, todayHK, estateId, todayHK).all();
  const firstSeenTodaySet = new Set(todayFirstSeen.map(r => r.listing_id));

  for (const [ref, nl] of newMap) {
    if (!oldMap.has(ref)) {
      if (firstSeenTodaySet.has(ref)) newAdded.push(nl);
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
  const { results: estates } = await db.prepare("SELECT * FROM estates WHERE is_disabled = 0 OR is_disabled IS NULL").all();
  const results = await Promise.all(
    estates.map(async (estate) => {
      try {
        const [data, newTxns] = await Promise.all([
          fetchCentanet(estate.name),
          fetchNewTransactions(estate.name),
        ]);
        const listings = data.data || [];
        await saveSearchResults(db, estate.id, listings);
        const changes = await detectChanges(db, estate.id, estate.name, listings);
        changes.newTransactions = newTxns;
        return { estate: estate.name, count: listings.length, ok: true, changes };
      } catch (err) {
        return { estate: estate.name, error: err.message, ok: false };
      }
    })
  );

  // Send email if there are any changes (exclude estates added today — first sync, no baseline)
  if (resendApiKey) {
    const hkNow = new Date(Date.now() + 8 * 3600 * 1000);
    const today = hkNow.toISOString().slice(0, 10);
    const estateMap = Object.fromEntries(estates.map(e => [e.name, e]));
    const allChanges = results.filter(r => {
      if (!r.ok || !r.changes) return false;
      const e = estateMap[r.estate];
      if (e?.first_seen && e.first_seen.slice(0, 10) === today) return false;
      return true;
    }).map(r => r.changes);
    const hasChanges = allChanges.some(
      c => c.priceChanges.length || c.newListings.length || c.removedListings.length || (c.newTransactions || []).length
    );
    if (hasChanges) {
      const totalTxns  = allChanges.reduce((s, c) => s + (c.newTransactions || []).length, 0);
      const totalPrice = allChanges.reduce((s, c) => s + c.priceChanges.length, 0);
      const totalNew   = allChanges.reduce((s, c) => s + c.newListings.length, 0);
      const totalDel   = allChanges.reduce((s, c) => s + c.removedListings.length, 0);
      const parts = [];
      if (totalTxns)  parts.push(`${totalTxns} 個新成交`);
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
             FROM estates e WHERE (e.is_disabled = 0 OR e.is_disabled IS NULL) ORDER BY e.is_favourite DESC, e.sort_order ASC`
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
        } else if (estate.is_disabled) {
          await db.prepare("UPDATE estates SET is_disabled = 0 WHERE id = ?").bind(estate.id).run();
          estate = { ...estate, is_disabled: 0 };
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
            `WITH latest AS (
               SELECT MAX(snapshot_date) AS d FROM listings WHERE estate_id = ?
             ),
             per_listing AS (
               SELECT listing_id,
                 MIN(snapshot_date) AS first_seen,
                 MAX(snapshot_date) AS last_seen
               FROM listings WHERE estate_id = ?
               GROUP BY listing_id
             )
             SELECT l.*,
               pl.first_seen,
               CASE WHEN pl.last_seen < latest.d THEN pl.last_seen ELSE NULL END AS removed_date,
               prev.price AS prev_price,
               prev.price_per_ft AS prev_price_per_ft
             FROM listings l
             JOIN per_listing pl ON pl.listing_id = l.listing_id
             JOIN latest ON 1=1
             LEFT JOIN listing_price_history prev
               ON prev.ref_no = l.ref_no
               AND prev.snapshot_date = (
                 SELECT MAX(snapshot_date) FROM listing_price_history
                 WHERE ref_no = l.ref_no AND snapshot_date < l.snapshot_date
               )
             WHERE l.estate_id = ? AND l.snapshot_date = pl.last_seen
             ORDER BY removed_date IS NOT NULL ASC, l.price ASC`
          )
          .bind(estateId, estateId, estateId)
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

      if (method === "GET" && path.match(/^\/api\/estates\/\d+\/transactions$/)) {
        const estateId = path.split("/")[3];
        const estate = await db.prepare("SELECT name FROM estates WHERE id = ?").bind(estateId).first();
        if (!estate) return json(404, { error: "Not found" });
        const offset = Number(url.searchParams.get("offset") || 0);
        const res = await fetch(CENTANET_TRANS, {
          method: "POST",
          headers: FETCH_HEADERS,
          body: JSON.stringify({
            postType: "Sale",
            size: 50,
            offset,
            keyword: estate.name,
          }),
          ...CF_OPTIONS,
        });
        if (!res.ok) return json(502, { error: `Centanet error ${res.status}` });
        const raw = await res.json();

        // Load saved HS valuations for this estate
        const { results: savedVals } = await db
          .prepare("SELECT building, floor, flat, price, saleable_area, valuation_date FROM hangseng_valuations WHERE estate_id = ?")
          .bind(estateId).all();
        const valMap = new Map(savedVals.map(v => [`${v.building}|${v.floor}|${v.flat}`, v]));

        const txns = (raw.data || []).map(t => {
          const blockNum   = (t.buildingName || '').match(/\d+/)?.[0] || '';
          const floorNum   = (t.yAxis || '').match(/\d+/)?.[0] || '';
          const flatLetter = (t.xAxis || '').replace(/[室層樓]/g, '').trim();
          const saved = valMap.get(`${blockNum}|${floorNum}|${flatLetter}`);
          return {
            id: t.id,
            building: t.buildingName,
            floor: t.yAxis,
            unit: t.xAxis,
            price: t.transactionPrice,
            size_gross: t.gArea,
            size_net: t.nArea,
            price_per_ft_net: t.nUnitPrice,
            price_per_ft_gross: t.gUnitPrice,
            reg_date: t.regDate?.slice(0, 10),
            prev_price: t.prevTransactionPrice,
            gain_pct: t.gainPercent,
            held_days: t.heldDay,
            detail_url: t.detailUrl,
            hs_price: saved ? saved.price : null,
            hs_date: saved ? saved.valuation_date : null,
          };
        });
        return json(200, { transactions: txns, total: raw.data?.length ?? 0 });
      }

      if (method === "GET" && path === "/api/hangseng-valuation") {
        const estateId   = url.searchParams.get("estateId");
        const estateName = url.searchParams.get("estate");
        const blockNum   = url.searchParams.get("block");
        const floorNum   = url.searchParams.get("floor");
        const flatLetter = url.searchParams.get("flat");
        if (!estateName || !blockNum || !floorNum || !flatLetter)
          return json(400, { error: "Missing params" });

        // Check D1 cache first
        if (estateId) {
          const cached = await db.prepare(
            "SELECT price, saleable_area, valuation_date FROM hangseng_valuations WHERE estate_id=? AND building=? AND floor=? AND flat=?"
          ).bind(estateId, blockNum, floorNum, flatLetter).first();
          if (cached) {
            // Log to history once per day
            const todayEntry = await db.prepare(
              "SELECT id FROM hangseng_valuation_history WHERE estate_id=? AND building=? AND floor=? AND flat=? AND date(fetched_at)=date('now') LIMIT 1"
            ).bind(estateId, blockNum, floorNum, flatLetter).first();
            if (!todayEntry) {
              await db.prepare(
                "INSERT INTO hangseng_valuation_history (estate_id, building, floor, flat, price, saleable_area, valuation_date) VALUES (?,?,?,?,?,?,?)"
              ).bind(estateId, blockNum, floorNum, flatLetter, cached.price, cached.saleable_area, cached.valuation_date).run();
            }
            return json(200, { price: String(cached.price), saleableArea: String(cached.saleable_area), valuationDate: cached.valuation_date, cached: true });
          }
        }

        const result = await getHangSengValuation(estateName, blockNum, floorNum, flatLetter);
        if (!result) return json(404, { error: "Not found" });

        // Save to D1 (latest + history once per day)
        if (estateId) {
          await db.prepare(
            "INSERT OR REPLACE INTO hangseng_valuations (estate_id, building, floor, flat, price, saleable_area, valuation_date) VALUES (?,?,?,?,?,?,?)"
          ).bind(estateId, blockNum, floorNum, flatLetter, Number(result.price), Number(result.saleableArea), result.valuationDate).run();
          const todayEntry = await db.prepare(
            "SELECT id FROM hangseng_valuation_history WHERE estate_id=? AND building=? AND floor=? AND flat=? AND date(fetched_at)=date('now') LIMIT 1"
          ).bind(estateId, blockNum, floorNum, flatLetter).first();
          if (!todayEntry) {
            await db.prepare(
              "INSERT INTO hangseng_valuation_history (estate_id, building, floor, flat, price, saleable_area, valuation_date) VALUES (?,?,?,?,?,?,?)"
            ).bind(estateId, blockNum, floorNum, flatLetter, Number(result.price), Number(result.saleableArea), result.valuationDate).run();
          }
        }

        return json(200, result);
      }

      if (method === "GET" && path === "/api/hangseng-valuation-history") {
        const estateId   = url.searchParams.get("estateId");
        const blockNum   = url.searchParams.get("block");
        const floorNum   = url.searchParams.get("floor");
        const flatLetter = url.searchParams.get("flat");
        if (!estateId || !blockNum || !floorNum || !flatLetter)
          return json(400, { error: "Missing params" });
        const { results } = await db.prepare(
          "SELECT price, saleable_area, valuation_date, fetched_at FROM hangseng_valuation_history WHERE estate_id=? AND building=? AND floor=? AND flat=? ORDER BY fetched_at DESC LIMIT 20"
        ).bind(estateId, blockNum, floorNum, flatLetter).all();
        return json(200, { history: results });
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
        await db.prepare("UPDATE estates SET is_disabled = 1 WHERE id = ?").bind(estateId).run();
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
            estate: "碧海藍天",
            newTransactions: [
              { building: "3座", floor: "高層", unit: "A室", size_net: 513, price: 9280000, price_per_ft: 18090, gain_pct: 15.3, held_days: 2738, reg_date: "2026-06-19" },
              { building: "6座", floor: "中層", unit: "D室", size_net: 491, price: 8080000, price_per_ft: 16456, gain_pct: -3.0, held_days: 2628, reg_date: "2026-06-19" },
            ],
            priceChanges: [
              { building: "2座", floor: "高層", unit: "C室", oldPrice: 8500000, newPrice: 7980000 },
            ],
            newListings: [
              { building_name: "5座", floor: "低層", unit: "B室", bedrooms: 2, size_net: 501, price: 7200000, price_per_ft: 14371 },
            ],
            removedListings: [],
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
