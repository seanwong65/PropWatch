#!/usr/bin/env python3
"""屋苑專頁生成器（2026-11-03）。
  python3 tools/estate/gen.py --all --remote        # 讀 production D1（只讀），生成全部屋苑頁＋總覽頁＋sitemap 區塊＋pages.json
  python3 tools/estate/gen.py --all --db <sqlite>    # 讀本機 dump
  python3 tools/estate/gen.py --only 4 --remote       # 只重做一個（唔會動總覽／sitemap）
生成完要再行：python3 tools/area/gen.py（地區頁連入屋苑頁）、python3 tools/seo/sitemap_lastmod.py，然後 build／commit／deploy。
⚠️ 每日自動更新未做（用戶決定遲啲有多啲人用先做）：頁面寫「資料截至 X」，要更新就重行呢個 script 再 deploy。

只出**匯總**數字，唔出任何單一單位嘅座／層／室／價錢。數字定義同 worker/estateStats.js 一致（每個 source 最新一日 snapshot、
跨 source 按「座|層|室|面積」去重、呎價中位數、成交 <5 宗唔計中位）；另外：太舊嘅 source 唔計入（防止下架咗嘅盤當現有），
太舊／太少盤嘅屋苑唔出頁。
D1 讀取：全部用 (estate_id, …) 索引 seek，每個屋苑約幾千 rows，冇全表 scan。"""
import sys, os, json, html, sqlite3, statistics, datetime, re, glob, subprocess, threading, urllib.parse
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "area")); sys.path.insert(0, HERE)
from data import D as AREAS            # noqa: E402
from areas import DISTRICT_AREA        # noqa: E402

ROOT = os.path.join(HERE, "..", "..")
OUT = os.path.join(ROOT, "frontend", "estate")
BASE = "https://home.ws-techs.com"
OG = f"{BASE}/images/og-default.jpg"
PSV = "20261022b"
SOURCES = ["centanet", "midland", "hkp", "ricacorp"]
FRESH_DAYS = 14        # 最新一日 snapshot 離今日超過呢個日數＝停咗 sync，唔出頁
SRC_FRESH_DAYS = 3     # 單一 source 比整體最新舊過呢個日數＝停咗，唔計入（唔當現有放盤）
MIN_LISTINGS = 5       # 去重後放盤少過呢個數＝太薄，唔出頁
MIN_TRACK_DAYS = 60    # 我哋記錄呢個屋苑少過呢個日數：減價比例會被低估（冇歷史）唔出；放盤日數只用地產網自己嘅上盤日期
e = html.escape


# ── 數據來源（本機 sqlite／production D1 經 wrangler，都係只讀）──────────────────────────────
class Local:
    def __init__(self, path):
        try:
            self.c = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False); self.c.execute("SELECT 1 FROM estates LIMIT 1")
        except sqlite3.OperationalError:
            self.c = sqlite3.connect(f"file:{path}?immutable=1", uri=True, check_same_thread=False)
        self.c.row_factory = sqlite3.Row
        self.lock = threading.Lock()
    def qs(self, sqls):
        with self.lock: return [[dict(r) for r in self.c.execute(s).fetchall()] for s in sqls]


class Remote:
    def qs(self, sqls):
        for attempt in range(3):
            p = subprocess.run(["npx", "wrangler", "d1", "execute", "propwatch-db", "--remote", "--json", "--command", ";\n".join(sqls)],
                               cwd=os.path.join(ROOT, "worker"), capture_output=True, text=True, env={**os.environ, "TMPDIR": "/tmp"})
            try:
                j = json.loads(p.stdout)
                if all(x.get("success") for x in j): return [x["results"] for x in j]
            except Exception:
                pass
            if attempt == 2: sys.exit("D1 query failed:\n" + (p.stderr or p.stdout)[-600:])


def med(xs):
    xs = [x for x in xs if x is not None and x > 0]
    return statistics.median(xs) if xs else None
def d(s): return datetime.date.fromisoformat(s[:10])
def wan(p): return f"${p / 1e4:,.0f}萬" if p >= 1e6 else f"${p / 1e4:,.1f}萬"
def psf(x): return f"${int(x + 0.5):,}"   # 同 JS Math.round 一致（Python round 係銀行家捨入）
def zh_date(s): dd = d(s); return f"{dd.month}月{dd.day}日"
def ok_date(s): return bool(s) and bool(re.match(r"^\d{4}-\d{2}-\d{2}", str(s)))
def slug_of(name): return re.sub(r"[\\/?#%&\s]+", "-", name).strip("-")
def url_of(slug): return f"{BASE}/estate/{urllib.parse.quote(slug, safe='')}"


def area_of(est):
    name = est["name"]
    for a in AREAS.values():
        if any(name in r[2] for r in a["rows"]): return a
    sl = DISTRICT_AREA.get(est.get("district") or "")
    return next((a for a in AREAS.values() if a["slug"] == sl), None) if sl else None
def area_name(a): return a["name"] if a["name"].endswith("區") else a["name"] + "區"


# ── 計算 ─────────────────────────────────────────────────────────────────────────────────────
def compute(src, est, today):
    eid = int(est["id"])
    srow, = src.qs([f"SELECT (SELECT MIN(snapshot_date) FROM listings WHERE estate_id={eid}) AS first_snap, " + ", ".join(f"(SELECT MAX(snapshot_date) FROM listings WHERE estate_id={eid} AND source='{s}') AS {s}" for s in SOURCES)])
    latest = {s: srow[0][s][:10] for s in SOURCES if srow and srow[0].get(s)}
    if not latest: return None, "冇放盤數據"
    as_of = max(latest.values())
    if (today - d(as_of)).days > FRESH_DAYS: return None, f"數據太舊（{as_of}）"
    first_snap = (srow[0].get("first_snap") or as_of)[:10]
    live = {s: x for s, x in latest.items() if (d(as_of) - d(x)).days <= SRC_FRESH_DAYS}
    cond = " OR ".join(f"(source='{s}' AND snapshot_date='{x}')" for s, x in live.items())
    sub = f"SELECT ref_no FROM listings WHERE estate_id={eid} AND price>0 AND ({cond})"
    rows, spans, lph, txs, stt = src.qs([
        f"SELECT source, ref_no, listing_id, building_name, floor, unit, size_net, price, price_per_ft, bedrooms, publish_date FROM listings WHERE estate_id={eid} AND price>0 AND ({cond})",
        f"SELECT listing_id, first_seen FROM listing_span WHERE estate_id={eid} AND last_seen>='{as_of}'",
        f"SELECT ref_no, price, snapshot_date FROM listing_price_history WHERE estate_id={eid} AND ref_no IN ({sub})",
        f"SELECT reg_date, price_per_ft AS p FROM transactions WHERE estate_id={eid} AND price_per_ft>0 AND reg_date>=date('{as_of}','-12 months')",
        f"SELECT data FROM estate_stats WHERE estate_id={eid}"])
    span = {r["listing_id"]: r["first_seen"] for r in spans}
    hist = {}
    for r in sorted(lph, key=lambda r: r["snapshot_date"]): hist.setdefault(r["ref_no"], []).append(r["price"])
    groups = {}
    for r in rows:
        groups.setdefault((r["building_name"] or "", r["floor"] or "", r["unit"] or r["ref_no"], round(r["size_net"] or 0)), []).append(r)
    units = []
    for g in groups.values():
        f = g[0]
        pubs = [r["publish_date"][:10] for r in g if ok_date(r["publish_date"])]
        dates = pubs + [x[:10] for x in [span.get(r["listing_id"]) for r in g] if x]
        days = (d(as_of) - d(min(dates))).days if dates else None
        cut = max([(h[0] - h[-1]) / h[0] for r in g for h in [hist.get(r["ref_no"], [])] if len(h) >= 2 and h[0] and h[-1] < h[0]] or [0])
        units.append(dict(price=f["price"], psf=f["price_per_ft"], beds=f["bedrooms"], days=days, cut=cut, pub=bool(pubs)))
    if len(units) < MIN_LISTINGS: return None, f"放盤太少（{len(units)}）"
    t12 = [(r["reg_date"][:10], r["p"]) for r in txs if ok_date(r["reg_date"])]
    tx3 = [p for rd, p in t12 if rd >= (d(as_of) - datetime.timedelta(days=91)).isoformat()]
    st = json.loads(stt[0]["data"]) if stt else {}
    return dict(est=est, as_of=as_of, units=units, tx3=tx3, t12=t12, st=st, first_snap=first_snap, tracked=(d(as_of) - d(first_snap)).days), None


def analyse(Dd):
    U = Dd["units"]; n = len(U)
    A = dict(n=n, psf=med([u["psf"] for u in U]), price=med([u["price"] for u in U]))
    A["tx_n"] = len(Dd["tx3"]); A["tx_psf"] = med(Dd["tx3"]) if len(Dd["tx3"]) >= 5 else None
    A["gap"] = round((A["psf"] / A["tx_psf"] - 1) * 100, 1) if A["psf"] and A["tx_psf"] else None
    long_track = Dd["tracked"] >= MIN_TRACK_DAYS
    days = [u["days"] for u in U if u["days"] is not None and (long_track or u["pub"])]
    A["days_med"] = statistics.median(days) if len(days) >= max(3, n // 2) else None
    A["buckets"] = [(l, sum(1 for x in days if f(x))) for l, f in [("30 日內", lambda x: x < 30), ("30–90 日", lambda x: 30 <= x < 90), ("90–180 日", lambda x: 90 <= x < 180), ("180 日以上", lambda x: x >= 180)]] if A["days_med"] is not None else []
    cuts = [u["cut"] for u in U if u["cut"] > 0]
    A["cut_share"] = round(len(cuts) / n * 100) if long_track else None     # 記錄太短＝冇減價歷史，唔出
    A["cut_avg"] = round(statistics.mean(cuts) * 100, 1) if cuts and long_track else None
    beds = {}
    for u in U:
        if u["beds"] is not None: beds.setdefault(min(int(u["beds"]), 4), []).append(u)
    A["beds"] = [(("開放式" if b == 0 else "4 房或以上" if b == 4 else f"{b} 房"), len(v), med([x["psf"] for x in v]), med([x["price"] for x in v])) for b, v in sorted(beds.items())]
    q = {}
    for rd, p in Dd["t12"]:
        dd = d(rd); q.setdefault((dd.year, (dd.month - 1) // 3 + 1), []).append(p)
    A["quarters"] = [(f"{y} 年第 {k} 季", len(v), med(v) if len(v) >= 3 else None) for (y, k), v in sorted(q.items())]
    return A


# ── 頁面 ─────────────────────────────────────────────────────────────────────────────────────
FOOT = '''<footer class="site-foot">
  <nav aria-label="網站連結">
    <a href="/">搵樓日記</a>
    <a href="/search">搵樓</a>
    <a href="/area/">各區樓盤</a>
    <a href="/estate/">屋苑數據</a>
    <a href="/mortgage-calculator">按揭計算機</a>
    <a href="/guides/">買樓教學</a>
    <a href="/about">關於我們</a>
    <a href="/privacy">私隱政策</a>
  </nav>
  <div>搵樓日記唔係地產代理，亦唔係銀行。數據收集自公開地產網站，只供參考。</div>
</footer>'''
HEAD_ICONS = '''  <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png">
  <link rel="shortcut icon" href="/favicon.ico">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <meta name="theme-color" content="#1270ac">'''
TOP = '''<header class="top">
  <a class="top-logo" href="/"><img src="/icons/icon-192.png" width="30" height="30" alt=""> 搵樓日記</a>
  <nav class="top-actions">
    <a class="top-btn" href="/app#login">登入</a>
    <a class="top-btn primary" href="/app#register">免費註冊</a>
  </nav>
</header>'''
GUIDES = [("asking-vs-transaction", "叫價同成交價差幾多先算抵？", "用成交中位數判斷貴定平"), ("listing-days", "點知一個盤放咗幾耐？", "放盤日數、減價歷史點睇"), ("negotiation", "買樓點樣講價？", "用放盤日數、減價紀錄、成交價做籌碼")]


def page(P, A, peers):
    E = P["est"]; name = E["name"]; as_of = P["as_of"]; st = P["st"]; slug = P["slug"]; url = url_of(slug)
    ar = area_of(E); aname = area_name(ar) if ar else None
    crumb_mid = f'<a href="/area/{ar["slug"]}">{e(aname)}</a>' if ar else '<a href="/estate/">屋苑數據</a>'
    ld_mid = {"name": aname, "item": f"{BASE}/area/{ar['slug']}"} if ar else {"name": "屋苑數據", "item": f"{BASE}/estate/"}
    bits = []
    if E.get("completion_year"): bits.append(f"{E['completion_year']} 年落成")
    if E.get("blocks") and E.get("total_units"): bits.append(f"{E['blocks']} 座共 {E['total_units']:,} 伙")
    elif E.get("total_units"): bits.append(f"共 {E['total_units']:,} 伙")
    if E.get("developer"): bits.append(f"發展商：{E['developer']}")
    about = "，".join(bits)
    lead = (f"{name}{('（' + about + '）') if about else ''}截至{zh_date(as_of)}有 {A['n']} 個放盤單位（已跨四大地產網去重）"
            + (f"，叫價實用呎價中位數 {psf(A['psf'])}" if A["psf"] else "") + "。")
    if A["tx_psf"]: lead += f"近 3 個月有 {A['tx_n']} 宗成交，成交實用呎價中位數 {psf(A['tx_psf'])}，叫價比成交{'貴' if A['gap'] >= 0 else '平'} {abs(A['gap'])}%。"
    if A["days_med"] is not None: lead += f"放盤日數中位數 {round(A['days_med'])} 日" + (f"，{A['cut_share']}% 嘅盤減過價" + (f"（平均減 {A['cut_avg']}%）" if A["cut_avg"] else "") if A["cut_share"] is not None else "") + "。"
    cards = [("放盤單位", f"{A['n']}", "個（去重後）"), ("叫價呎價中位", psf(A["psf"]) if A["psf"] else "—", "每實用呎"),
             ("近 3 個月成交呎價中位", psf(A["tx_psf"]) if A["tx_psf"] else "—", f"{A['tx_n']} 宗成交" if A["tx_psf"] else f"{A['tx_n']} 宗（未夠 5 宗唔計）"),
             ("叫價比成交", (("貴 " if A["gap"] >= 0 else "平 ") + f"{abs(A['gap'])}%") if A["gap"] is not None else "—", "叫價呎價 ÷ 成交呎價")]
    cards_html = "".join(f'<div class="es-card"><small>{e(a)}</small><b>{e(b)}</b><span>{e(c)}</span></div>' for a, b, c in cards)
    wk = f"過去 {st['span_days']} 日：新放盤 {st['new']} 個、下架 {st['removed']} 個、{st['cuts']} 個減價。" if st.get("span_days") and st.get("new") is not None else ""
    sec_days = ""
    if A["days_med"] is not None:
        mx = max([c for _, c in A["buckets"]] + [1])
        bk = "".join(f'<div class="es-bar"><span>{e(l)}</span><i style="width:{round(c / mx * 100)}%"></i><b>{c}</b></div>' for l, c in A["buckets"])
        sec_days = f'''  <section class="area-sec">
    <h2>{e(name)}嘅盤放咗幾耐？</h2>
    <p style="color:var(--muted);margin:0 0 0.5rem">現有 {A['n']} 個放盤嘅放盤日數分佈（中位數約 {round(A['days_med'])} 日）。{(str(A['cut_share']) + '% 嘅盤減過價' + (('，平均減 ' + str(A['cut_avg']) + '%') if A['cut_avg'] else '') + '。') if A['cut_share'] is not None else '減價比例要累積多啲記錄先計得準，暫時未顯示。'}</p>
    <div class="es-bars">{bk}</div>
    <p class="es-note">放盤日數按地產網顯示嘅上盤日期{('同搵樓日記自己嘅記錄（' + str(d(P['first_snap']).year) + ' 年 ' + str(d(P['first_snap']).month) + ' 月起）取較早者') if P['tracked'] >= MIN_TRACK_DAYS else '計（搵樓日記未有足夠記錄）'}；減價只計我哋開始記錄之後。想睇每個盤嘅逐次改價，<a href="/app#register">免費註冊追蹤</a>。</p>
  </section>
'''
    sec_beds = ""
    if A["beds"]:
        br = "".join(f"<tr><td>{e(l)}</td><td>{c}</td><td>{psf(p) if p else '—'}</td><td>{wan(pr) if pr else '—'}</td></tr>" for l, c, p, pr in A["beds"])
        sec_beds = f'''  <section class="area-sec">
    <h2>{e(name)}按房數嘅叫價</h2>
    <div class="area-table-wrap">
      <table class="es-table">
        <tr><th>房數</th><th>放盤數</th><th>呎價中位</th><th>樓價中位</th></tr>
{br}
      </table>
    </div>
  </section>
'''
    sec_q = ""
    if A["quarters"]:
        qmax = max([p for _, _, p in A["quarters"] if p] + [1])
        qh = "".join(f'<div class="es-bar"><span>{e(l)}</span><i style="width:{round((p or 0) / qmax * 100)}%"></i><b>{(psf(p) + "（" + str(c) + " 宗）") if p else (str(c) + " 宗（太少唔計）")}</b></div>' for l, c, p in A["quarters"])
        sec_q = f'''  <section class="area-sec">
    <h2>{e(name)}近 12 個月成交呎價（按季）</h2>
    <div class="es-bars">{qh}</div>
    <p class="es-note">成交實用呎價中位數，按登記日期分季；每季少過 3 宗唔計中位數。</p>
  </section>
'''
    faqs = [(f"{name}而家有幾多個放盤？", f"截至{zh_date(as_of)}，{name}喺四大地產網（中原、美聯、香港置業、利嘉閣）共有 {A['n']} 個放盤單位（同一單位多間代理放盤已去重）" + (f"，叫價實用呎價中位數 {psf(A['psf'])}。" if A["psf"] else "。"))]
    if A["tx_psf"]: faqs.append((f"{name}叫價同成交價差幾多？", f"近 3 個月 {A['tx_n']} 宗成交嘅實用呎價中位數係 {psf(A['tx_psf'])}，同期叫價呎價中位數 {psf(A['psf'])}，叫價{'貴' if A['gap'] >= 0 else '平'}約 {abs(A['gap'])}%。個別單位按樓層、座向、景觀同裝修會有差異。"))
    if A["days_med"] is not None: faqs.append((f"{name}嘅盤平均放咗幾耐？有幾多減過價？", f"現有放盤嘅放盤日數中位數約 {round(A['days_med'])} 日" + (f"；{A['cut_share']}% 嘅盤自我哋開始記錄後減過價" + (f"，平均減幅 {A['cut_avg']}%。" if A["cut_avg"] else "。") if A["cut_share"] is not None else "。減價比例要累積多啲記錄先計得準，暫時未顯示。") + "放盤日數以地產網顯示嘅上盤日期（同搵樓日記自己嘅記錄）為準。"))
    faqs.append((f"點樣追蹤{name}嘅減價同新盤？", f"免費註冊搵樓日記並追蹤{name}，系統每日自動記低每個盤嘅放盤日數、每次改價同下架去向，並同屋苑成交中位數比較。"))
    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "ApartmentComplex", "name": name, "url": url, "inLanguage": "zh-HK",
         **({"numberOfAccommodationUnits": E["total_units"]} if E.get("total_units") else {}),
         "address": {"@type": "PostalAddress", **({"addressLocality": E["district"]} if E.get("district") else {}), "addressRegion": "香港", "addressCountry": "HK"}},
        {"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "搵樓日記", "item": BASE + "/"},
            {"@type": "ListItem", "position": 2, **ld_mid},
            {"@type": "ListItem", "position": 3, "name": name, "item": url}]},
        {"@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faqs]}]}
    faq_html = "\n".join(f"    <details><summary>{e(q)}</summary><p>{e(a)}</p></details>" for q, a in faqs)
    title = f"{name}二手樓：放盤、呎價、成交同減價紀錄 — 搵樓日記"
    desc = (f"{name}截至{zh_date(as_of)}有 {A['n']} 個放盤" + (f"，叫價呎價中位數 {psf(A['psf'])}" if A["psf"] else "")
            + (f"，近 3 個月成交呎價中位數 {psf(A['tx_psf'])}" if A["tx_psf"] else "") + "；附放盤日數、減價比例同按季成交呎價，並即時搜尋四大地產網放盤。")
    chips = ([f'<a href="/area/{ar["slug"]}">{e(aname)}二手樓放盤</a>', f'<a href="/area/{ar["slug"]}-rent">{e(aname)}租盤</a>'] if ar else []) + \
            [f'<a href="/estate/{urllib.parse.quote(p["slug"], safe="")}">{e(p["name"])}</a>' for p in peers] + ['<a href="/estate/">全部屋苑數據</a>']
    guides = "".join(f'<li><a href="/guides/{s}"><b>{e(t)}</b><small>{e(x)}</small></a></li>' for s, t, x in GUIDES)
    return f'''<!DOCTYPE html>
<html lang="zh-HK">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>{e(title)}</title>
  <meta name="description" content="{e(desc)}">
  <link rel="canonical" href="{url}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="搵樓日記">
  <meta property="og:locale" content="zh_HK">
  <meta property="og:url" content="{url}">
  <meta property="og:title" content="{e(name)}二手樓：放盤、呎價、成交同減價紀錄">
  <meta property="og:description" content="{e(desc)}">
  <meta property="og:image" content="{OG}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="{OG}">
{HEAD_ICONS}
  <link rel="stylesheet" href="/site.css">
  <link rel="stylesheet" href="/public-search.css?v={PSV}">
  <link rel="stylesheet" href="/area/area.css?v={PSV}">
  <link rel="stylesheet" href="/estate/estate.css?v=20261103b">
  <script type="application/ld+json">
{json.dumps(ld, ensure_ascii=False, indent=2)}
  </script>
</head>
<body>

{TOP}

<main class="ps-wrap ps-root">
  <nav class="crumb" aria-label="麵包屑"><a href="/">搵樓日記</a> › {crumb_mid} › {e(name)}</nav>
  <h1>{e(name)}二手樓：放盤、呎價、成交同減價紀錄</h1>
  <p class="area-intro">{e(lead)}</p>
  <div class="es-cards">{cards_html}</div>
  <p class="es-asof">資料截至 {e(zh_date(as_of))}。{e(wk)}</p>

{sec_days}{sec_beds}{sec_q}  <section class="area-sec" style="margin-top:2.2rem">
    <h2>{e(name)}最新放盤（即時）</h2>
    <p style="color:var(--muted);margin:0 0 0.4rem">四大地產網而家放緊嘅{e(name)}買盤，由平到貴排。</p>
  </section>
  <div id="estate-search"></div>

  <section class="cta" style="margin-top:2rem">
    <h2>追蹤{e(name)}，每日自動記低減價</h2>
    <p>免費註冊後追蹤{e(name)}：每個盤嘅放盤日數、每次減價、下架去向都會自動記低，叫價比屋苑成交貴定平一眼睇晒。</p>
    <a class="cta-btn" href="/app#register">免費開始追蹤</a>
  </section>

  <section class="area-sec">
    <h2>附近同類資料</h2>
    <div class="area-chips">{"".join(chips)}</div>
  </section>

  <section class="area-sec related">
    <h2>睇樓前先睇</h2>
    <ul>{guides}</ul>
  </section>

  <section class="area-sec">
    <h2>常見問題</h2>
{faq_html}
  </section>

  <p class="ps-note">放盤資料來自各地產代理網站，成交資料來自公開成交紀錄，由第三方提供，搵樓日記唔保證準確，實際情況請向代理核實。<br>搵樓日記唔係地產代理，亦唔構成投資意見。</p>
</main>

{FOOT}

<script src="/public-search.js?v={PSV}"></script>
<script>
  window.PublicSearch.mount(document.getElementById("estate-search"), {{ embedded: true, hook: true, initial: {{ kw: {json.dumps(name, ensure_ascii=False)} }} }});
</script>
</body>
</html>
'''


def hub(pages):
    groups = {}
    for p in pages:
        ar = area_of(p["est"]); groups.setdefault(ar["slug"] if ar else "other", []).append(p)
    blocks = []
    for region in ["港島", "九龍", "新界", "離島"]:
        for a in [a for a in AREAS.values() if a["region"] == region]:
            ps = sorted(groups.get(a["slug"], []), key=lambda p: -p["A"]["n"])
            if not ps: continue
            lis = "\n".join(f'      <li><a class="card-link" href="/estate/{urllib.parse.quote(p["slug"], safe="")}"><b>{e(p["name"])}</b>'
                            f'<span>{p["A"]["n"]} 個放盤' + (f'・叫價 {psf(p["A"]["psf"])}/呎' if p["A"]["psf"] else "") + '</span></a></li>' for p in ps)
            blocks.append(f'    <h2><a href="/area/{a["slug"]}" style="color:inherit;text-decoration:none">{e(area_name(a))}</a></h2>\n    <ul class="card-list">\n{lis}\n    </ul>')
    if groups.get("other"):
        lis = "\n".join(f'      <li><a class="card-link" href="/estate/{urllib.parse.quote(p["slug"], safe="")}"><b>{e(p["name"])}</b><span>{p["A"]["n"]} 個放盤</span></a></li>' for p in sorted(groups["other"], key=lambda p: -p["A"]["n"]))
        blocks.append(f'    <h2>其他</h2>\n    <ul class="card-list">\n{lis}\n    </ul>')
    newest = max(p["as_of"] for p in pages)
    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "CollectionPage", "name": "香港屋苑二手樓放盤、呎價、成交數據", "url": f"{BASE}/estate/", "inLanguage": "zh-HK"},
        {"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "搵樓日記", "item": BASE + "/"},
            {"@type": "ListItem", "position": 2, "name": "屋苑數據", "item": f"{BASE}/estate/"}]}]}
    desc = f"{len(pages)} 個香港屋苑嘅二手樓放盤數目、叫價呎價中位數、近期成交呎價、放盤日數同減價比例，按地區分類，每個屋苑一頁。"
    return f'''<!DOCTYPE html>
<html lang="zh-HK">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>香港屋苑二手樓數據：放盤、呎價、成交、減價紀錄 — 搵樓日記</title>
  <meta name="description" content="{e(desc)}">
  <link rel="canonical" href="{BASE}/estate/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="搵樓日記">
  <meta property="og:locale" content="zh_HK">
  <meta property="og:url" content="{BASE}/estate/">
  <meta property="og:title" content="香港屋苑二手樓數據：放盤、呎價、成交、減價紀錄">
  <meta property="og:description" content="{e(desc)}">
  <meta property="og:image" content="{OG}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="{OG}">
{HEAD_ICONS}
  <link rel="stylesheet" href="/site.css">
  <link rel="stylesheet" href="/area/area.css?v={PSV}">
  <script type="application/ld+json">
{json.dumps(ld, ensure_ascii=False, indent=2)}
  </script>
</head>
<body>

{TOP}

<main class="wrap">
  <nav class="crumb" aria-label="麵包屑"><a href="/">搵樓日記</a> › 屋苑數據</nav>
  <h1>香港屋苑二手樓數據：放盤、呎價、成交、減價紀錄</h1>
  <p class="area-intro">{len(pages)} 個屋苑嘅現有放盤數目、叫價實用呎價中位數、近期成交呎價、放盤日數同減價比例（資料最新到 {e(zh_date(newest))}）。放盤整合中原、美聯、香港置業、利嘉閣，同一單位多間代理放盤已去重。想按地區睇放盤，去<a href="/area/">各區樓盤</a>。</p>
  <div class="area-hub">
{chr(10).join(blocks)}
  </div>
  <p class="ps-note" style="margin-top:2rem">放盤資料來自各地產代理網站，成交資料來自公開成交紀錄，由第三方提供，搵樓日記唔保證準確。</p>
</main>

{FOOT}
</body>
</html>
'''


def sitemap_block(pages):
    items = [(f"{BASE}/estate/", max(p["as_of"] for p in pages))] + [(url_of(p["slug"]), p["as_of"]) for p in pages]
    return "<!-- estate:start -->\n" + "\n".join(f"  <url>\n    <loc>{u}</loc>\n    <lastmod>{m}</lastmod>\n  </url>" for u, m in items) + "\n  <!-- estate:end -->"


def main():
    a = sys.argv[1:]
    if not a: sys.exit(__doc__)
    src = Remote() if "--remote" in a else Local(a[a.index("--db") + 1] if "--db" in a else glob.glob(os.path.join(ROOT, "worker/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite"))[0])
    today = d(a[a.index("--today") + 1]) if "--today" in a else (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).date()
    ests, = src.qs(["SELECT id, name, district, completion_year, blocks, total_units, developer FROM estates WHERE is_disabled=0 ORDER BY id"])
    only = int(a[a.index("--only") + 1]) if "--only" in a else None
    if only: ests = [x for x in ests if x["id"] == only]
    with ThreadPoolExecutor(max_workers=3) as ex: res = list(ex.map(lambda x: compute(src, x, today), ests))
    pages, skipped = [], []
    for est, (P, why) in zip(ests, res):
        (skipped.append((est["id"], est["name"], why)) if P is None else pages.append(P))
    # 重名：先到先得（id 細嘅），之後嘅加 district／id
    used = {}
    for P in sorted(pages, key=lambda p: p["est"]["id"]):
        s = slug_of(P["est"]["name"])
        if s in used: s = slug_of(f"{P['est']['name']}-{P['est'].get('district') or P['est']['id']}")
        while s in used: s += f"-{P['est']['id']}"
        used[s] = P; P["slug"] = s; P["name"] = P["est"]["name"]; P["A"] = analyse(P)
    if not only:
        for f in glob.glob(os.path.join(OUT, "*.html")): os.remove(f)   # 舊樣本、已停用屋苑嘅頁一律清走
    os.makedirs(OUT, exist_ok=True)
    for P in pages:
        ar = area_of(P["est"])
        peers = sorted([q for q in pages if q is not P and ar and area_of(q["est"]) and area_of(q["est"])["slug"] == ar["slug"]], key=lambda q: -q["A"]["n"])[:6]
        open(os.path.join(OUT, P["slug"] + ".html"), "w", encoding="utf-8").write(page(P, P["A"], peers))
    if not only:
        open(os.path.join(OUT, "index.html"), "w", encoding="utf-8").write(hub(pages))
        json.dump([dict(id=p["est"]["id"], name=p["name"], slug=p["slug"], area=(area_of(p["est"]) or {}).get("slug"), n=p["A"]["n"], psf=p["A"]["psf"], as_of=p["as_of"]) for p in pages],
                  open(os.path.join(HERE, "pages.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        sm = os.path.join(ROOT, "frontend", "sitemap.xml"); s = open(sm, encoding="utf-8").read()
        blk = sitemap_block(pages)
        s = re.sub(r"<!-- estate:start -->.*?<!-- estate:end -->", lambda m: blk, s, flags=re.S) if "<!-- estate:start -->" in s else s.replace("</urlset>", f"  {blk}\n</urlset>")
        open(sm, "w", encoding="utf-8").write(s)
    print(f"生成 {len(pages)} 頁；略過 {len(skipped)}：")
    for i, n, why in skipped: print(f"  - {i} {n}：{why}")
    um = [p["name"] for p in pages if not area_of(p["est"])]
    if um: print("未對應地區（放『其他』，要補 tools/estate/areas.py）：", "、".join(um))


if __name__ == "__main__":
    main()
