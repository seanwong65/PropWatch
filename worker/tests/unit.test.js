import { describe, it, expect } from "vitest";
import { scrapeRicacorpListings } from "../index.js";

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

// ── ricacorp pagination ────────────────────────────────────────────────────
// These tests import the REAL scrapeRicacorpListings from index.js (not a copy),
// so they cannot drift from deployed behaviour.

// Builds a minimal SSR-HTML fixture matching what the scraper parses.
function fakeRicacorpHtml(refs, slug) {
  const detailBlocks = refs
    .map(ref => `<a href="/zh-hk/property/detail/four-hma-est-1-block-${ref}-3-hk">x</a>`)
    .join("");
  const urlindex = slug
    ? `xURLINDEX&q;:{&q;locationId&q;:&q;abc&q;,&q;alias&q;:&q;${slug}&q;},&q;POSTS&q;:1`
    : "";
  return urlindex + detailBlocks;
}

describe("scrapeRicacorpListings — URL encoding (deterministic, mocked fetch)", () => {
  // Regression guard for the CF-Workers HTTP 400 bug: pagination URLs must be
  // percent-encoded. Node's fetch auto-encodes, so this asserts on the URL the
  // scraper *constructs*, catching a dropped encodeURIComponent without network.
  it("percent-encodes CJK slug in page 2+ URLs (no raw non-ASCII)", async () => {
    const requestedUrls = [];
    const slug = "淘大花園-bigest-九龍灣-hma-hk";
    const pages = [
      fakeRicacorpHtml(["cf10000001", "cf10000002"], slug), // page 1 (has slug)
      fakeRicacorpHtml(["cf20000001"], null),               // page 2
      fakeRicacorpHtml([], null),                            // page 3 → stops
    ];

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (u) => {
      const body = pages[requestedUrls.length] ?? "";
      requestedUrls.push(typeof u === "string" ? u : u.url);
      return { ok: true, text: async () => body };
    };
    try {
      const startUrl = "https://www.ricacorp.com/zh-hk/property/list/buy/" + encodeURIComponent("淘大花園");
      const listings = await scrapeRicacorpListings(startUrl);
      expect(listings.length).toBe(3); // 2 from page 1 + 1 from page 2
    } finally {
      globalThis.fetch = origFetch;
    }

    const paginationUrls = requestedUrls.slice(1); // page 2 onwards
    expect(paginationUrls.length).toBeGreaterThan(0);
    for (const u of paginationUrls) {
      expect(u).toContain(";page=");
      expect(/[^\x00-\x7F]/.test(u)).toBe(false); // CF Workers rejects raw CJK with HTTP 400
    }
  });

  it("stops when a page yields no new listings", async () => {
    const requestedUrls = [];
    const pages = [
      fakeRicacorpHtml(["cf30000001"], "est-hma-hk"),
      fakeRicacorpHtml([], null), // immediately empty → stop after page 2 fetch
    ];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (u) => {
      const body = pages[requestedUrls.length] ?? "";
      requestedUrls.push(typeof u === "string" ? u : u.url);
      return { ok: true, text: async () => body };
    };
    try {
      const listings = await scrapeRicacorpListings("https://www.ricacorp.com/zh-hk/property/list/buy/est");
      expect(listings.length).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(requestedUrls.length).toBe(2); // page 1 + one empty page, then stop
  });
});

describe("scrapeRicacorpListings — live integration", () => {
  // 淘大花園 has ~65 listings across 7 pages. Requiring ≥ 40 proves genuine
  // multi-page pagination (the page-1-only bug caps at 10) while tolerating
  // a single flaky page fetch.
  it("fetches multiple pages for 淘大花園 via short estate name (≥ 40)", async () => {
    const url = "https://www.ricacorp.com/zh-hk/property/list/buy/" + encodeURIComponent("淘大花園");
    const listings = await scrapeRicacorpListings(url);
    expect(listings.length).toBeGreaterThanOrEqual(40);
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
