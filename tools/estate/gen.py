#!/usr/bin/env python3
"""屋苑專頁生成器（2026-11-03 樣本）：python3 tools/estate/gen.py <estate_id> [--db <sqlite>] [--index]
由 D1 dump（本機 sqlite，只讀）算**匯總數字**，輸出靜態頁 frontend/estate/<id>.html。
- 只出匯總（放盤數、呎價／樓價中位、放盤日數分佈、減價比例、房數分佈、按季成交呎價）——唔出任何單一單位嘅樓層／座數／價錢。
- 數字定義同 worker/estateStats.js 一致：每個 source 最新一日 snapshot、跨 source 按「座|層|室|面積」去重、呎價中位數、成交取近 3 個月（<5 宗唔計中位）。
- 預設 noindex（樣本）；--index 先會出可收錄版本（仲未做，要用戶批准先）。
- 零依賴（淨 python3 標準庫）。"""
import sys, os, json, html, sqlite3, statistics, datetime, re, glob
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "area"))
from data import D as AREAS   # 地區資料（屋苑→所屬地區，用嚟做麵包屑同連結）

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
OUT = os.path.join(ROOT, "frontend", "estate")
BASE = "https://home.ws-techs.com"
OG = f"{BASE}/images/og-default.jpg"
PSV = "20261022b"
SOURCES = ["centanet", "midland", "hkp", "ricacorp"]
e = html.escape


def med(xs):
    xs = [x for x in xs if x is not None and x > 0]
    return statistics.median(xs) if xs else None


def d(s): return datetime.date.fromisoformat(s)
def wan(p): return f"${p / 1e4:,.0f}萬" if p >= 1e6 else f"${p / 1e4:,.1f}萬"
def psf(x): return f"${round(x):,}"
def zh_date(s): dd = d(s); return f"{dd.month}月{dd.day}日"
def valid_date(s): return bool(s) and bool(re.match(r"^\d{4}-\d{2}-\d{2}", s)) and s[:10]


def compute(db, eid):
    try:
        c = sqlite3.connect(f"file:{db}?mode=ro", uri=True); c.execute("SELECT 1 FROM estates LIMIT 1")
    except sqlite3.OperationalError:   # 冇 -wal／-shm（唔係 wrangler 寫緊）時 mode=ro 開唔到，改 immutable（純只讀）
        c = sqlite3.connect(f"file:{db}?immutable=1", uri=True)
    c.row_factory = sqlite3.Row
    est = c.execute("SELECT * FROM estates WHERE id=?", (eid,)).fetchone()
    if not est: sys.exit(f"冇呢個屋苑 id={eid}")
    latest = {}
    for s in SOURCES:
        r = c.execute("SELECT MAX(snapshot_date) m FROM listings WHERE estate_id=? AND source=?", (eid, s)).fetchone()["m"]
        if r: latest[s] = r
    if not latest: sys.exit("冇放盤數據")
    as_of = max(latest.values())[:10]
    rows = []
    for s, ds in latest.items():
        rows += c.execute("SELECT * FROM listings WHERE estate_id=? AND source=? AND snapshot_date=? AND price>0", (eid, s, ds)).fetchall()
    span = {r["listing_id"]: r["first_seen"] for r in c.execute("SELECT listing_id, first_seen FROM listing_span WHERE estate_id=?", (eid,))}
    # 去重
    groups = {}
    for r in rows:
        k = (r["building_name"] or "", r["floor"] or "", r["unit"] or r["ref_no"], round(r["size_net"] or 0))
        groups.setdefault(k, []).append(r)
    units = []
    for k, g in groups.items():
        first = g[0]
        dates = [x for x in [valid_date(r["publish_date"]) for r in g] + [span.get(r["listing_id"]) for r in g] if x]
        days = (d(as_of) - d(min(dates)[:10])).days if dates else None
        # 減價：每個 ref 由第一個價到最新價；取組內最大減幅
        cut = 0.0
        for r in g:
            h = c.execute("SELECT price FROM listing_price_history WHERE ref_no=? ORDER BY snapshot_date", (r["ref_no"],)).fetchall()
            if len(h) >= 2 and h[0]["price"] and h[-1]["price"] < h[0]["price"]:
                cut = max(cut, (h[0]["price"] - h[-1]["price"]) / h[0]["price"])
        units.append(dict(price=first["price"], psf=first["price_per_ft"], size=first["size_net"], beds=first["bedrooms"], days=days, cut=cut))
    # 成交
    t3 = c.execute("SELECT price_per_ft p FROM transactions WHERE estate_id=? AND price_per_ft>0 AND reg_date>=date(?, '-3 months')", (eid, as_of)).fetchall()
    tx3 = [r["p"] for r in t3]
    t12 = c.execute("SELECT reg_date, price_per_ft p FROM transactions WHERE estate_id=? AND price_per_ft>0 AND reg_date>=date(?, '-12 months')", (eid, as_of)).fetchall()
    st = c.execute("SELECT data FROM estate_stats WHERE estate_id=?", (eid,)).fetchone()
    st = json.loads(st["data"]) if st else {}
    return dict(est=dict(est), as_of=as_of, units=units, tx3=tx3, t12=[(r["reg_date"], r["p"]) for r in t12], st=st, srcs=len(latest))


def analyse(D):
    U = D["units"]; n = len(U)
    A = dict(n=n, psf=med([u["psf"] for u in U]), price=med([u["price"] for u in U]))
    A["pmin"], A["pmax"] = (min(u["price"] for u in U), max(u["price"] for u in U)) if U else (None, None)
    A["tx_n"] = len(D["tx3"]); A["tx_psf"] = med(D["tx3"]) if len(D["tx3"]) >= 5 else None
    A["gap"] = round((A["psf"] / A["tx_psf"] - 1) * 100, 1) if A["psf"] and A["tx_psf"] else None
    days = [u["days"] for u in U if u["days"] is not None]
    A["days_n"] = len(days); A["days_med"] = statistics.median(days) if days else None
    B = [("30 日內", lambda x: x < 30), ("30–90 日", lambda x: 30 <= x < 90), ("90–180 日", lambda x: 90 <= x < 180), ("180 日以上", lambda x: x >= 180)]
    A["buckets"] = [(l, sum(1 for x in days if f(x))) for l, f in B]
    cuts = [u["cut"] for u in U if u["cut"] > 0]
    A["cut_share"] = round(len(cuts) / n * 100) if n else None
    A["cut_avg"] = round(statistics.mean(cuts) * 100, 1) if cuts else None
    beds = {}
    for u in U:
        if u["beds"] is None: continue
        beds.setdefault(min(int(u["beds"]), 4), []).append(u)
    A["beds"] = [(("開放式" if b == 0 else "4 房或以上" if b == 4 else f"{b} 房"), len(v), med([x["psf"] for x in v]), med([x["price"] for x in v])) for b, v in sorted(beds.items())]
    q = {}
    for rd, p in D["t12"]:
        dd = d(rd[:10]); q.setdefault((dd.year, (dd.month - 1) // 3 + 1), []).append(p)
    A["quarters"] = [(f"{y} 年第 {k} 季", len(v), med(v) if len(v) >= 3 else None) for (y, k), v in sorted(q.items())]
    return A


def area_of(name):
    for a in AREAS.values():
        if any(name in r[2] for r in a["rows"]): return a
    return None


def page(D, A, sample=True):
    E = D["est"]; name = E["name"]; as_of = D["as_of"]; st = D["st"]
    ar = area_of(name)
    aname = (ar["name"] if ar["name"].endswith("區") else ar["name"] + "區") if ar else None
    crumb_mid = f'<a href="/area/{ar["slug"]}">{e(aname)}</a>' if ar else '<a href="/area/">各區樓盤</a>'
    ld_mid = ({"name": aname, "item": f"{BASE}/area/{ar['slug']}"} if ar else {"name": "各區樓盤", "item": f"{BASE}/area/"})
    url = f"{BASE}/estate/{E['id']}"
    bits = []
    if E.get("completion_year"): bits.append(f"{E['completion_year']} 年落成")
    if E.get("blocks") and E.get("total_units"): bits.append(f"{E['blocks']} 座共 {E['total_units']:,} 伙")
    if E.get("developer"): bits.append(f"發展商：{E['developer']}")
    about = "，".join(bits)
    lead = (f"{name}{('（' + about + '）') if about else ''}截至{zh_date(as_of)}有 {A['n']} 個放盤單位（已跨四大地產網去重），"
            f"叫價實用呎價中位數 {psf(A['psf'])}")
    if A["tx_psf"]: lead += f"；近 3 個月有 {A['tx_n']} 宗成交，成交實用呎價中位數 {psf(A['tx_psf'])}，叫價比成交{'貴' if A['gap'] >= 0 else '平'} {abs(A['gap'])}%"
    lead += "。"
    if A["days_med"] is not None: lead += f"放盤日數中位數 {round(A['days_med'])} 日，{A['cut_share']}% 嘅盤減過價" + (f"（平均減 {A['cut_avg']}%）" if A["cut_avg"] else "") + "。"
    cards = [("放盤單位", f"{A['n']}", "個（去重後）"), ("叫價呎價中位", psf(A["psf"]), "每實用呎"),
             ("近 3 個月成交呎價中位", psf(A["tx_psf"]) if A["tx_psf"] else "—", f"{A['tx_n']} 宗成交" if A["tx_psf"] else f"{A['tx_n']} 宗（未夠 5 宗唔計）"),
             ("叫價比成交", (("貴 " if A["gap"] >= 0 else "平 ") + f"{abs(A['gap'])}%") if A["gap"] is not None else "—", "叫價呎價 ÷ 成交呎價")]
    cards_html = "".join(f'<div class="es-card"><small>{e(a)}</small><b>{e(b)}</b><span>{e(c)}</span></div>' for a, b, c in cards)
    mx = max([c for _, c in A["buckets"]] + [1])
    bk_html = "".join(f'<div class="es-bar"><span>{e(l)}</span><i style="width:{round(c / mx * 100)}%"></i><b>{c}</b></div>' for l, c in A["buckets"])
    beds_html = "".join(f"<tr><td>{e(l)}</td><td>{c}</td><td>{psf(p) if p else '—'}</td><td>{wan(pr) if pr else '—'}</td></tr>" for l, c, p, pr in A["beds"])
    qmax = max([p for _, _, p in A["quarters"] if p] + [1])
    q_html = "".join(f'<div class="es-bar"><span>{e(l)}</span><i style="width:{round((p or 0) / qmax * 100)}%"></i><b>{(psf(p) + "（" + str(c) + " 宗）") if p else (str(c) + " 宗（太少唔計）")}</b></div>' for l, c, p in A["quarters"])
    wk = ""
    if st.get("span_days") and st.get("new") is not None:
        wk = f"過去 {st['span_days']} 日：新放盤 {st['new']} 個、下架 {st['removed']} 個、{st['cuts']} 個減價。"
    faqs = [
        (f"{name}而家有幾多個放盤？", f"截至{zh_date(as_of)}，{name}喺四大地產網（中原、美聯、香港置業、利嘉閣）共有 {A['n']} 個放盤單位（同一單位多間代理放盤已去重），叫價實用呎價中位數 {psf(A['psf'])}。"),
    ]
    if A["tx_psf"]:
        faqs.append((f"{name}叫價同成交價差幾多？", f"近 3 個月 {A['tx_n']} 宗成交嘅實用呎價中位數係 {psf(A['tx_psf'])}，同期叫價呎價中位數 {psf(A['psf'])}，叫價{'貴' if A['gap'] >= 0 else '平'}約 {abs(A['gap'])}%。個別單位按樓層、座向、景觀同裝修會有差異。"))
    if A["days_med"] is not None:
        faqs.append((f"{name}嘅盤平均放咗幾耐？有幾多減過價？", f"現有放盤嘅放盤日數中位數約 {round(A['days_med'])} 日；{A['cut_share']}% 嘅盤自我哋開始記錄後減過價" + (f"，平均減幅 {A['cut_avg']}%。" if A["cut_avg"] else "。") + "放盤日數以地產網顯示嘅上盤日期同搵樓日記自己嘅記錄為準。"))
    faqs.append((f"點樣追蹤{name}嘅減價同新盤？", f"免費註冊搵樓日記並追蹤{name}，系統每日自動記低每個盤嘅放盤日數、每次改價同下架去向，並同屋苑成交中位數比較。"))
    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "ApartmentComplex", "name": name, "url": url, "inLanguage": "zh-HK",
         **({"numberOfAccommodationUnits": E["total_units"]} if E.get("total_units") else {}),
         "address": {"@type": "PostalAddress", "addressLocality": E.get("district") or "", "addressRegion": "香港", "addressCountry": "HK"}},
        {"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "搵樓日記", "item": BASE + "/"},
            {"@type": "ListItem", "position": 2, **ld_mid},
            {"@type": "ListItem", "position": 3, "name": name, "item": url}]},
        {"@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faqs]}]}
    faq_html = "\n".join(f"    <details><summary>{e(q)}</summary><p>{e(a)}</p></details>" for q, a in faqs)
    title = f"{name}二手樓：放盤、呎價、成交同減價紀錄 — 搵樓日記"
    desc = f"{name}截至{zh_date(as_of)}有 {A['n']} 個放盤，叫價呎價中位數 {psf(A['psf'])}" + (f"，近 3 個月成交呎價中位數 {psf(A['tx_psf'])}" if A["tx_psf"] else "") + "；附放盤日數分佈、減價比例同按季成交呎價，並即時搜尋四大地產網放盤。"
    banner = f'<div class="es-sample">⚠️ 樣本頁（noindex，未入 sitemap，冇連結入嚟）：數字取自 {e(zh_date(as_of))} 嘅資料庫備份，只供睇格式；正式版會每日更新。</div>' if sample else ""
    return f'''<!DOCTYPE html>
<html lang="zh-HK">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>{e(title)}</title>
  <meta name="description" content="{e(desc)}">
  <meta name="robots" content="{'noindex' if sample else 'index,follow'}">
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
  <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png">
  <link rel="shortcut icon" href="/favicon.ico">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <meta name="theme-color" content="#1270ac">
  <link rel="stylesheet" href="/site.css">
  <link rel="stylesheet" href="/public-search.css?v={PSV}">
  <link rel="stylesheet" href="/area/area.css?v={PSV}">
  <link rel="stylesheet" href="/estate/estate.css?v=20261103a">
  <script type="application/ld+json">
{json.dumps(ld, ensure_ascii=False, indent=2)}
  </script>
</head>
<body>

<header class="top">
  <a class="top-logo" href="/"><img src="/icons/icon-192.png" width="30" height="30" alt=""> 搵樓日記</a>
  <nav class="top-actions">
    <a class="top-btn" href="/app#login">登入</a>
    <a class="top-btn primary" href="/app#register">免費註冊</a>
  </nav>
</header>

<main class="ps-wrap ps-root">
  {banner}
  <nav class="crumb" aria-label="麵包屑"><a href="/">搵樓日記</a> › {crumb_mid} › {e(name)}</nav>
  <h1>{e(name)}二手樓：放盤、呎價、成交同減價紀錄</h1>
  <p class="area-intro">{e(lead)}</p>
  <div class="es-cards">{cards_html}</div>
  <p class="es-asof">資料截至 {e(zh_date(as_of))}。{e(wk)}</p>

  <section class="area-sec">
    <h2>{e(name)}嘅盤放咗幾耐？</h2>
    <p style="color:var(--muted);margin:0 0 0.5rem">現有 {A['n']} 個放盤嘅放盤日數分佈（中位數約 {round(A['days_med']) if A['days_med'] is not None else '—'} 日）。{A['cut_share']}% 嘅盤減過價{('，平均減 ' + str(A['cut_avg']) + '%') if A['cut_avg'] else ''}。</p>
    <div class="es-bars">{bk_html}</div>
    <p class="es-note">放盤日數按地產網顯示嘅上盤日期同搵樓日記自己嘅記錄（2026 年 6 月起）取較早者；減價只計我哋開始記錄之後。想睇每個盤嘅逐次改價，<a href="/app#register">免費註冊追蹤</a>。</p>
  </section>

  <section class="area-sec">
    <h2>{e(name)}按房數嘅叫價</h2>
    <div class="area-table-wrap">
      <table class="es-table">
        <tr><th>房數</th><th>放盤數</th><th>呎價中位</th><th>樓價中位</th></tr>
{beds_html}
      </table>
    </div>
  </section>

  <section class="area-sec">
    <h2>{e(name)}近 12 個月成交呎價（按季）</h2>
    <div class="es-bars">{q_html}</div>
    <p class="es-note">成交實用呎價中位數，按登記日期分季；每季少過 3 宗唔計中位數。</p>
  </section>

  <section class="area-sec" style="margin-top:2.2rem">
    <h2>{e(name)}最新放盤（即時）</h2>
    <p style="color:var(--muted);margin:0 0 0.4rem">四大地產網而家放緊嘅{e(name)}買盤，由平到貴排。</p>
  </section>
  <div id="estate-search"></div>

  <section class="cta" style="margin-top:2rem">
    <h2>追蹤{e(name)}，每日自動記低減價</h2>
    <p>免費註冊後追蹤{e(name)}：每個盤嘅放盤日數、每次減價、下架去向都會自動記低，叫價比屋苑成交貴定平一眼睇晒。</p>
    <a class="cta-btn" href="/app#register">免費開始追蹤</a>
  </section>

  {('<section class="area-sec"><h2>附近同類資料</h2><div class="area-chips"><a href="/area/' + ar["slug"] + '">' + e(aname) + '二手樓放盤</a><a href="/area/' + ar["slug"] + '-rent">' + e(aname) + '租盤</a><a href="/area/">全港各區</a></div></section>') if ar else ""}

  <section class="area-sec">
    <h2>常見問題</h2>
{faq_html}
  </section>

  <p class="ps-note">放盤資料來自各地產代理網站，成交資料來自公開成交紀錄，由第三方提供，搵樓日記唔保證準確，實際情況請向代理核實。<br>搵樓日記唔係地產代理，亦唔構成投資意見。</p>
</main>

<footer class="site-foot">
  <nav aria-label="網站連結">
    <a href="/">搵樓日記</a>
    <a href="/search">搵樓</a>
    <a href="/area/">各區樓盤</a>
    <a href="/mortgage-calculator">按揭計算機</a>
    <a href="/guides/">買樓教學</a>
    <a href="/about">關於我們</a>
    <a href="/privacy">私隱政策</a>
  </nav>
  <div>搵樓日記唔係地產代理，亦唔係銀行。數據收集自公開地產網站，只供參考。</div>
</footer>

<script src="/public-search.js?v={PSV}"></script>
<script>
  window.PublicSearch.mount(document.getElementById("estate-search"), {{ embedded: true, hook: true, initial: {{ kw: {json.dumps(name, ensure_ascii=False)} }} }});
</script>
</body>
</html>
'''


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a: sys.exit(__doc__)
    eid = int(a[0]); db = a[a.index("--db") + 1] if "--db" in a else (glob.glob(os.path.join(ROOT, "worker/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite")) or [None])[0]
    if "--index" in a: sys.exit("可收錄版本未批准，暫時只出 noindex 樣本")
    D = compute(db, eid); A = analyse(D)
    os.makedirs(OUT, exist_ok=True)
    open(os.path.join(OUT, f"{eid}.html"), "w", encoding="utf-8").write(page(D, A))
    print(json.dumps({k: v for k, v in A.items()}, ensure_ascii=False, indent=1)[:1800])
