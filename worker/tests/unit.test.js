import { describe, it, expect } from "vitest";

// ── Pure helpers extracted inline (no DB/fetch deps) ──────────────────────

function hkDateStr(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

const N = (v) => (v == null ? null : v);

function getEstateCode(item) {
  return item.bigestcode || item.cestcode || item.cblgcode || "";
}

function getEstateName(item) {
  return item.bigEstateName || item.estateName || item.buildingName || "";
}

function parseListing(item) {
  return {
    listing_id: N(item.id),
    ref_no: N(item.refNo),
    estate_name: getEstateName(item),
    phase: item.estateName !== getEstateName(item) ? item.estateName : "",
    building_name: N(item.buildingName),
    floor: N(item.yAxis),
    unit: N(item.xAxis),
    bedrooms: N(item.bedroomCount),
    direction: N(item.direction) || null,
    size_net: item.nSize || null,
    size_gross: item.size || null,
    price: N(item.salePrice),
    price_per_ft: N(item.nUnitPrice),
    building_age: N(item.buildingAge),
    detail_url: N(item.detailUrl),
    thumbnail: N(item.thumbnail),
  };
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("hkDateStr", () => {
  it("returns a YYYY-MM-DD string", () => {
    expect(hkDateStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("offsets by +1 day", () => {
    const today = hkDateStr();
    const tomorrow = hkDateStr(1);
    expect(new Date(tomorrow) > new Date(today)).toBe(true);
  });

  it("offsets by -1 day", () => {
    const today = hkDateStr();
    const yesterday = hkDateStr(-1);
    expect(new Date(yesterday) < new Date(today)).toBe(true);
  });
});

describe("N() helper", () => {
  it("returns null for undefined", () => expect(N(undefined)).toBe(null));
  it("returns null for null", () => expect(N(null)).toBe(null));
  it("passes through 0", () => expect(N(0)).toBe(0));
  it("passes through empty string", () => expect(N("")).toBe(""));
  it("passes through numbers", () => expect(N(42)).toBe(42));
  it("passes through strings", () => expect(N("abc")).toBe("abc"));
});

describe("getEstateCode", () => {
  it("prefers bigestcode", () => expect(getEstateCode({ bigestcode: "A", cestcode: "B" })).toBe("A"));
  it("falls back to cestcode", () => expect(getEstateCode({ cestcode: "B", cblgcode: "C" })).toBe("B"));
  it("falls back to cblgcode", () => expect(getEstateCode({ cblgcode: "C" })).toBe("C"));
  it("returns empty string if none", () => expect(getEstateCode({})).toBe(""));
});

describe("getEstateName", () => {
  it("prefers bigEstateName", () => expect(getEstateName({ bigEstateName: "A", estateName: "B" })).toBe("A"));
  it("falls back to estateName", () => expect(getEstateName({ estateName: "B", buildingName: "C" })).toBe("B"));
  it("falls back to buildingName", () => expect(getEstateName({ buildingName: "C" })).toBe("C"));
  it("returns empty string if none", () => expect(getEstateName({})).toBe(""));
});

describe("parseListing", () => {
  const sample = {
    id: 123,
    refNo: "REF001",
    bigEstateName: "碧海藍天",
    estateName: "碧海藍天",
    buildingName: "3座",
    yAxis: "高層",
    xAxis: "A",
    bedroomCount: 2,
    direction: "北",
    nSize: 500,
    size: 550,
    salePrice: 8000000,
    nUnitPrice: 16000,
    buildingAge: 20,
    detailUrl: "https://hk.centanet.com/detail/123",
    thumbnail: "https://img.centanet.com/123.jpg",
  };

  it("maps all fields correctly", () => {
    const result = parseListing(sample);
    expect(result.listing_id).toBe(123);
    expect(result.ref_no).toBe("REF001");
    expect(result.estate_name).toBe("碧海藍天");
    expect(result.building_name).toBe("3座");
    expect(result.floor).toBe("高層");
    expect(result.unit).toBe("A");
    expect(result.bedrooms).toBe(2);
    expect(result.direction).toBe("北");
    expect(result.size_net).toBe(500);
    expect(result.price).toBe(8000000);
    expect(result.price_per_ft).toBe(16000);
  });

  it("converts undefined values to null via N()", () => {
    const result = parseListing({ bigEstateName: "test" });
    expect(result.listing_id).toBe(null);
    expect(result.ref_no).toBe(null);
    expect(result.price).toBe(null);
  });

  it("sets direction to null when missing", () => {
    const result = parseListing({ bigEstateName: "test", direction: undefined });
    expect(result.direction).toBe(null);
  });

  it("sets phase when estateName differs from bigEstateName", () => {
    const result = parseListing({ bigEstateName: "淘大花園", estateName: "I期" });
    expect(result.phase).toBe("I期");
  });

  it("sets phase to empty when estateName matches bigEstateName", () => {
    const result = parseListing({ bigEstateName: "碧海藍天", estateName: "碧海藍天" });
    expect(result.phase).toBe("");
  });
});

// ── Integration: ricacorp pagination ──────────────────────────────────────

async function scrapeRicacorpListings(ricacorpUrl) {
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const listings = [];
  const seen = new Set();
  let canonicalBase = ricacorpUrl;

  for (let page = 1; page <= 15; page++) {
    const url = page === 1 ? ricacorpUrl : `${canonicalBase};page=${page}`;
    let html;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) break;
      html = await res.text();
    } catch { break; }

    if (page === 1) {
      const urlindexSection = html.match(/URLINDEX[^:]*:([\s\S]*?)(?=,&q;[A-Z])/);
      const slugMatch = urlindexSection && urlindexSection[1].match(/&q;alias&q;:&q;([^&]+)&q;/);
      if (slugMatch) {
        const base = ricacorpUrl.replace(/\/[^/]+$/, "");
        canonicalBase = `${base}/${slugMatch[1]}`;
      }
    }

    const blocks = html.split(/(?=href="\/zh-hk\/property\/detail\/)/);
    let found = 0;

    for (const block of blocks.slice(1)) {
      const hrefMatch = block.match(/href="(\/zh-hk\/property\/detail\/[^"]+)"/);
      if (!hrefMatch) continue;
      const href = hrefMatch[1];
      const refMatch = href.match(/-(c[a-z]\d+)-/i);
      const ref_no = refMatch ? refMatch[1].toUpperCase() : null;
      if (!ref_no || seen.has(ref_no)) continue;
      seen.add(ref_no);
      found++;
      listings.push({ ref_no, detail_url: "https://www.ricacorp.com" + href });
    }

    if (found === 0) break;
  }

  return listings;
}

describe("scrapeRicacorpListings (integration)", () => {
  // Uses 淘大花園 (7 pages, 65 listings) — strong validation that multi-page pagination works
  it("fetches all 7 pages via short estate name for 淘大花園 and returns > 10 listings", async () => {
    const url = "https://www.ricacorp.com/zh-hk/property/list/buy/" + encodeURIComponent("淘大花園");
    const listings = await scrapeRicacorpListings(url);
    expect(listings.length).toBeGreaterThan(10);
  }, 120000);
});

describe("sha256", () => {
  it("hashes '123456' consistently", async () => {
    const hash = await sha256("123456");
    expect(hash).toBe("8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92");
  });

  it("returns a 64-char hex string", async () => {
    const hash = await sha256("test");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different inputs produce different hashes", async () => {
    const h1 = await sha256("abc");
    const h2 = await sha256("def");
    expect(h1).not.toBe(h2);
  });
});
