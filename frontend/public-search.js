// 公開搜尋頁（/search）——未登入都用得，即時問四大地產網（經 worker /api/public/search）。
// 每個網站獨立一個 request（並行），邊個返先出邊個；一個網站死咗唔影響其他。
// ⚠️ 地產網回嚟嘅字串全部當唔可信：入 HTML 一律行底部嘅 escHtml／safeUrl／safeImgSrc。
// 搜尋條件放喺 URL（?deal=S&kw=…&beds=2&pmin=500&pmax=800…），可以分享／收藏；
// pmin/pmax 喺 URL 同表單都係「買盤＝萬、租盤＝元」，send 去 worker 先換做 HK$。

// production 用自訂域名 api.ws-techs.com（workers.dev 冇 Cache API，同一組條件會每次都問地產網）
const API = location.hostname === "home.ws-techs.com"
  ? "https://api.ws-techs.com"
  : (location.hostname === "localhost" || location.hostname === "127.0.0.1")
    ? "http://localhost:8787"
    : "https://propwatch-worker-test.johnwong777.workers.dev";

const SRC = {
  centanet: { name: "中原" },
  midland:  { name: "美聯" },
  hkp:      { name: "香港置業" },
  ricacorp: { name: "利嘉閣" },
};
const SRC_KEYS = Object.keys(SRC);
const MAX_PAGE = 10;                 // worker 都係最多 10 頁

const $ = (id) => document.getElementById(id);
const form = $("ps-form");
let runId = 0;                       // 新搜尋作廢舊 request 嘅結果
let state = null;                    // { cond, srcs: { [src]: { page, pageSize, total, status, busy } }, items: [] }
let sortMode = "mix";
const cardCache = new Map();         // key → card element（重新排序唔使重整，張相唔會閃）

// ── URL ⇄ 表單 ─────────────────────────────────────────────
function readCond(sp) {
  const n = (k) => {
    const v = sp.get(k);
    if (v == null || v === "") return null;
    const x = Math.round(Number(v));
    return Number.isFinite(x) && x >= 0 ? x : null;
  };
  const srcs = sp.getAll("src").filter((s) => SRC[s]);
  const beds = n("beds");
  return {
    deal: sp.get("deal") === "R" ? "R" : "S",
    kw: String(sp.get("kw") || "").trim().slice(0, 30),
    beds: beds >= 1 && beds <= 4 ? beds : null,
    pmin: n("pmin"), pmax: n("pmax"), smin: n("smin"), smax: n("smax"),
    srcs: srcs.length ? [...new Set(srcs)] : SRC_KEYS.slice(),
  };
}
function condToQuery(c) {
  const sp = new URLSearchParams();
  if (c.deal === "R") sp.set("deal", "R");
  if (c.kw) sp.set("kw", c.kw);
  for (const k of ["beds", "pmin", "pmax", "smin", "smax"]) if (c[k] != null) sp.set(k, c[k]);
  if (c.srcs.length < SRC_KEYS.length) for (const s of c.srcs) sp.append("src", s);
  return sp.toString();
}
function fillForm(c) {
  form.querySelector(`input[name="deal"][value="${c.deal}"]`).checked = true;
  $("ps-kw").value = c.kw;
  $("ps-beds").value = c.beds ?? "";
  for (const k of ["pmin", "pmax", "smin", "smax"]) $("ps-" + k).value = c[k] ?? "";
  for (const el of form.querySelectorAll('input[name="src"]')) el.checked = c.srcs.includes(el.value);
  syncPriceLabel();
}
function syncPriceLabel() {
  const rent = form.querySelector('input[name="deal"]:checked').value === "R";
  $("ps-price-label").textContent = rent ? "月租（元）" : "售價（萬）";
  $("ps-pmin").placeholder = rent ? "例如 15000" : "最低";
  $("ps-pmax").placeholder = rent ? "例如 25000" : "最高";
}

// ── 搜尋 ───────────────────────────────────────────────────
function apiUrl(c, src, page) {
  const sp = new URLSearchParams({ src, deal: c.deal });
  if (c.kw) sp.set("kw", c.kw);
  if (c.beds != null) sp.set("beds", c.beds);
  const mul = c.deal === "R" ? 1 : 10000;          // 買盤表單係萬
  if (c.pmin != null) sp.set("pmin", c.pmin * mul);
  if (c.pmax != null) sp.set("pmax", c.pmax * mul);
  if (c.smin != null) sp.set("smin", c.smin);
  if (c.smax != null) sp.set("smax", c.smax);
  if (page > 1) sp.set("page", page);
  return `${API}/api/public/search?${sp}`;
}

function startSearch(c) {
  const id = ++runId;
  state = { cond: c, srcs: {}, items: [] };
  for (const s of c.srcs) state.srcs[s] = { page: 0, pageSize: 12, total: null, status: "loading", busy: false };
  $("ps-grid").replaceChildren();
  cardCache.clear();
  renderTitle();
  renderAll();
  for (const s of c.srcs) fetchPage(id, s);
}

async function fetchPage(id, src) {
  const st = state.srcs[src];
  if (st.busy) return;
  st.busy = true;
  const page = st.page + 1;
  renderMore();
  let res, body;
  try {
    res = await fetch(apiUrl(state.cond, src, page));
    body = await res.json().catch(() => ({}));
  } catch {
    res = null; body = {};
  }
  if (id !== runId) return;
  st.busy = false;
  if (!res || !res.ok) {
    // 地產網限流（利嘉閣 JSON API 每個 IP 大約 8–10 秒先准一次）：worker 回 retry 秒數，
    // 每頁自動再試一次；再唔得先當失敗，畀條連結去原網站自己搵
    const wait = Number(body.retry);
    if (wait > 0 && st.retriedPage !== page) {
      st.retriedPage = page;
      if (page === 1) st.status = "retrying";
      st.busy = true;                        // 等緊嗰陣唔好俾「載入更多」再撳多次同一頁
      renderAll();
      setTimeout(() => { st.busy = false; if (id === runId) fetchPage(id, src); }, Math.min(wait, 15) * 1000 + 500);
      return;
    }
    if (page === 1) st.status = res?.status === 429 ? "busy" : res?.status === 503 ? "off" : "err";
    else st.moreErr = true;
    renderAll();
    return;
  }
  st.page = page;
  st.pageSize = body.pageSize || st.pageSize;
  if (body.unsupported) {
    st.status = "unsupported";
  } else {
    st.total = Number.isFinite(body.total) ? body.total : st.total;
    const seen = new Set(state.items.map((x) => x.key));
    (body.items || []).forEach((it, i) => {
      const key = `${src}|${it.url || i + ":" + page}`;
      if (seen.has(key)) return;
      seen.add(key);
      state.items.push({ ...it, src, key, rank: (page - 1) * st.pageSize + i });
    });
    st.status = "ok";
  }
  renderAll();
}

function loadMore() {
  for (const [src, st] of Object.entries(state.srcs)) if (hasMore(st)) fetchPage(runId, src);
}
const hasMore = (st) => st.status === "ok" && !st.busy && st.page < MAX_PAGE && st.total != null && st.page * st.pageSize < st.total;

function ricacorpListUrl(c) {
  const base = `https://www.ricacorp.com/zh-hk/property/list/${c.deal === "R" ? "rent" : "buy"}`;
  return c.kw ? `${base}/${encodeURIComponent(c.kw)}` : base;
}

// ── 排序 ───────────────────────────────────────────────────
function ordered() {
  const items = state.items.slice();
  const last = (v) => (v == null ? Infinity : v);
  if (sortMode === "new") return items.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || a.rank - b.rank);
  if (sortMode === "price") return items.sort((a, b) => last(a.price) - last(b.price));
  if (sortMode === "psf") return items.sort((a, b) => last(a.psf) - last(b.psf));
  // 四網輪流：每個網站按佢自己嘅次序（最新放盤先），輪住出，唔會頭幾十個全部係同一個網
  const bySrc = SRC_KEYS.map((s) => items.filter((x) => x.src === s));
  const out = [];
  for (let i = 0; out.length < items.length; i++) for (const arr of bySrc) if (arr[i]) out.push(arr[i]);
  return out;
}

// ── Render ─────────────────────────────────────────────────
function renderAll() {
  renderSrcbar();
  renderGrid();
  renderMore();
}

function renderTitle() {
  const c = state.cond;
  const bits = [];
  if (c.kw) bits.push(`「${c.kw}」`);
  if (c.beds) bits.push(c.beds >= 4 ? "4房或以上" : `${c.beds}房`);
  if (c.pmin != null || c.pmax != null) {
    const u = c.deal === "R" ? (v) => "$" + v.toLocaleString("en-US") : (v) => `$${v}萬`;
    bits.push(c.pmin != null && c.pmax != null ? `${u(c.pmin)}–${u(c.pmax)}` : c.pmin != null ? `${u(c.pmin)}以上` : `${u(c.pmax)}以下`);
  }
  if (c.smin != null || c.smax != null) bits.push(`${c.smin ?? 0}–${c.smax ?? "∞"}呎`);
  const deal = c.deal === "R" ? "租盤" : "買盤";
  $("ps-title").textContent = bits.length ? `${bits.join(" · ")} ${deal}` : `全港最新${deal}`;
  document.title = (bits.length ? `${bits.join(" ")} ${deal}` : `全港最新${deal}`) + "｜四大地產網一次過搜尋 — 搵樓日記";
}

function renderSrcbar() {
  const html = Object.entries(state.srcs).map(([src, st]) => {
    let txt;
    if (st.status === "loading") txt = "搵緊…";
    else if (st.status === "retrying") txt = "網站繁忙，幾秒後自動再試…";
    else if (st.status === "ok") txt = st.total != null ? `${st.total.toLocaleString("en-US")} 個盤` : "有結果";
    else if (st.status === "unsupported") txt = "租盤暫未支援";
    else if (st.status === "busy") txt = "搜尋太頻密，一分鐘後再試";
    else if (st.status === "off") txt = "暫停中";
    else txt = "暫時搵唔到";
    // 搵唔到：利嘉閣有固定格式嘅搜尋頁，畀條連結自己去搵
    const out = st.status === "err" && src === "ricacorp"
      ? ` <a href="${safeUrl(ricacorpListUrl(state.cond))}" target="_blank" rel="noopener noreferrer nofollow">去利嘉閣網站搵 ↗</a>` : "";
    return `<span class="ps-stat"><span class="ps-badge b-${src}">${escHtml(SRC[src].name)}</span><small>${escHtml(txt)}${out}</small></span>`;
  }).join("");
  $("ps-srcbar").innerHTML = html;
}

function renderGrid() {
  const list = ordered();
  const grid = $("ps-grid");
  grid.replaceChildren(...list.map(cardEl));
  const msg = $("ps-msg");
  const loading = Object.values(state.srcs).some((s) => s.status === "loading" || s.status === "retrying");
  if (!list.length) {
    msg.hidden = false;
    msg.textContent = loading ? "搵緊四大地產網…" : "冇搵到符合條件嘅放盤，試吓放寬價錢或者面積？";
  } else msg.hidden = true;
}

function renderMore() {
  if (!state) return;
  const sts = Object.values(state.srcs);
  const any = sts.some(hasMore);
  const busy = sts.some((s) => s.busy && s.page > 0);
  $("ps-more").hidden = !(any || busy);
  const btn = $("ps-more-btn");
  btn.disabled = busy;
  btn.textContent = busy ? "載入緊…" : "載入更多";
}

function cardEl(it) {
  let el = cardCache.get(it.key);
  if (el) return el;
  const wrap = document.createElement("div");
  wrap.innerHTML = cardHtml(it);
  el = wrap.firstElementChild;
  const img = el.querySelector("img");
  if (img) img.addEventListener("error", () => { img.parentElement.textContent = "🏠"; }, { once: true });
  cardCache.set(it.key, el);
  return el;
}

function cardHtml(it) {
  const name = SRC[it.src].name;
  const rent = state.cond.deal === "R";
  const img = safeImgSrc(it.img);
  const photo = img
    ? `<img src="${img}" alt="${escHtml(it.estate || it.title || "")}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : "🏠";
  const head = [it.estate, it.floor].filter(Boolean).join(" · ");
  // 副標題：座數／期數（title 開頭通常已經係屋苑名，唔好重覆）+ 地區
  const rest = it.estate && String(it.title || "").startsWith(it.estate) ? it.title.slice(it.estate.length).trim() : it.title;
  const sub = [rest && rest !== it.estate ? rest : "", it.district].filter(Boolean).join(" · ");
  const facts = [
    it.beds == null ? "" : it.beds === 0 ? `<span><b>開放式</b></span>` : `<span><b class="num">${escHtml(it.beds)}</b> 房</span>`,
    it.size ? `<span>實用 <b class="num">${escHtml(it.size.toLocaleString("en-US"))}</b> 呎</span>` : "",
  ].filter(Boolean).join("");
  const price = it.price
    ? (rent ? `$${escHtml(it.price.toLocaleString("en-US"))}<small>/月</small>` : `$${escHtml(fmtWan(it.price))}<small>萬</small>`)
    : `<small>價錢請睇原網站</small>`;
  const psf = it.psf ? `@$${escHtml(it.psf.toLocaleString("en-US"))}/呎` : "";
  const track = it.estate
    ? `<a class="ps-track" href="/app?track_name=${encodeURIComponent(it.estate)}#register" title="免費登記，每日記錄${escHtml(it.estate)}嘅加減價">🔔 追蹤加減價</a>`
    : "";
  return `<article class="ps-card">
    <div class="ps-photo">${photo}</div>
    <div class="ps-body">
      <div class="ps-top"><span class="ps-badge b-${it.src}">${escHtml(name)}</span><span class="ps-date">${escHtml(fmtDate(it.date))}</span></div>
      <div class="ps-title">${escHtml(head || it.title || "（未有屋苑名）")}${sub ? `<small>${escHtml(sub)}</small>` : ""}</div>
      ${facts ? `<div class="ps-facts">${facts}</div>` : ""}
      <div class="ps-money"><span class="ps-price num">${price}</span><span class="ps-psf num">${psf}</span></div>
      <div class="ps-cta">
        <a class="ps-out ${it.src}" href="${safeUrl(it.url)}" target="_blank" rel="noopener noreferrer nofollow">去${escHtml(name)}睇 ↗</a>
        ${track}
      </div>
    </div>
  </article>`;
}

// 668 → "668"；1288.5 → "1,288.5"（萬，最多 1 個小數）
function fmtWan(hkd) {
  const w = Math.round(hkd / 1000) / 10;
  return w.toLocaleString("en-US", { maximumFractionDigits: 1 });
}
function fmtDate(d) {
  if (!d) return "";
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(today) - Date.parse(d)) / 86400000);
  if (!Number.isFinite(days)) return "";
  if (days <= 0) return "今日";
  if (days === 1) return "尋日";
  if (days < 30) return `${days} 日前`;
  return d;
}

// ── 事件 ───────────────────────────────────────────────────
form.addEventListener("change", (e) => { if (e.target.name === "deal") syncPriceLabel(); });
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const c = readCond(new FormData(form));
  if (!new FormData(form).getAll("src").length) {
    alert("最少揀一個地產網");
    return;
  }
  const qs = condToQuery(c);
  history.pushState(null, "", qs ? `/search?${qs}` : "/search");
  startSearch(c);
});
window.addEventListener("popstate", () => {
  const c = readCond(new URLSearchParams(location.search));
  fillForm(c);
  startSearch(c);
});
$("ps-sort").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b) return;
  sortMode = b.dataset.v;
  for (const x of $("ps-sort").querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
  renderGrid();
});
$("ps-more-btn").addEventListener("click", loadMore);

// FormData 同 URLSearchParams 都有 get/getAll，readCond 兩樣都食
const initCond = readCond(new URLSearchParams(location.search));
// 首頁 form 會帶埋空白欄位（?deal=S&kw=&beds=），執靚條 URL 方便分享
const initQs = condToQuery(initCond);
if (location.search.slice(1) !== initQs) history.replaceState(null, "", initQs ? `/search?${initQs}` : "/search");
fillForm(initCond);
startSearch(initCond);

// ── Escape helpers（同 app.html 一樣；地產網資料當唔可信）──
function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function safeUrl(u) {
  const s = String(u || "");
  return /^https?:\/\//i.test(s) ? escHtml(s) : "#";
}
function safeImgSrc(u) {
  const s = String(u || "");
  return (/^https?:\/\//i.test(s) || /^data:image\//i.test(s)) ? escHtml(s) : "";
}
