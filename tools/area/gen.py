import json, html, os, urllib.parse
from data import D, SLUG, NAME, RENT

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "frontend", "area")
BASE = "https://home.ws-techs.com"
OG = f"{BASE}/images/og-default.jpg"
PSV = "20261022b"
e = html.escape
GUIDE_LINKS = {"買舊樓要留意乜": "/guides/old-building", "居屋未補地價點計": "/guides/hos-premium", "單位有僭建點算": "/guides/unauthorised-works"}


def linkify(t):
    t = e(t)
    for k, href in GUIDE_LINKS.items():
        t = t.replace(f"見{k}", f'見<a href="{href}">{k}？</a>')
    return t


def kw(n, rent=False): return ("/search?deal=R&kw=" if rent else "/search?kw=") + urllib.parse.quote(n)


RENT_TIPS_COMMON = [
    ("入伙前要準備幾多錢", "一般要兩個月按金、一個月上期，經代理再加半個月佣金，仲有租約印花稅（詳見租樓注意事項）。"),
    ("生約死約同維修責任", "簽約前問清楚幾時可以提早退租、通知期幾耐，同埋冷氣、熱水爐等大件電器壞咗邊個負責。"),
]


def page(d, deal="S"):
    rent = deal == "R"
    c, name = d["code"], d["name"]
    slug = d["slug"] + ("-rent" if rent else "")
    url = f"{BASE}/area/{slug}"
    noun = "租盤" if rent else "二手樓"
    subs = "、".join(r[0].replace("・", "、") for r in d["rows"])
    estates = [x for r in d["rows"] for x in r[2]]
    top = estates[:3]
    if rent:
        desc = (f"{name}租盤一次睇：即時搜尋中原、美聯、香港置業、利嘉閣嘅{name}租樓放盤（{subs}），月租由低至高排。"
                f"附{name}分區、港鐵站同屋苑一覽，同埋喺{name}租樓要留意嘅嘢。免登入。")
    else:
        desc = (f"{name}二手樓放盤一次睇：即時搜尋中原、美聯、香港置業、利嘉閣嘅{name}買盤（{subs}），價錢由低至高排。"
                f"附{name}分區、港鐵站同屋苑一覽，同埋喺{name}買樓要留意嘅嘢。免登入。")
    faqs = []
    if estates:
        faqs.append((f"{name}{'租樓有咩屋苑揀' if rent else '有咩主要屋苑'}？", f"{name}嘅主要屋苑例如{'、'.join(estates)}。上面嘅即時搜尋可以輸入屋苑名直接睇{'租盤' if rent else '放盤'}。"))
    faqs.append((f"{name}交通點？", d["transport"]))
    if rent:
        faqs.append((f"喺{name}租樓要準備幾多錢？", "香港租樓常見要兩個月按金、一個月上期，經代理再加半個月租金做佣金，仲有租約印花稅（通常業主租客各付一半）。"))
        faqs.append(("點知個租盤租金貴定平？", "用同屋苑、相近面積嘅租盤同近期租務成交比較月租同實用呎租；同時計埋管理費、差餉邊個俾，同埋交通時間同車費。"))
    else:
        faqs.append((f"點知{name}嘅盤叫價貴定平？", "用同屋苑、相近面積、近三至六個月嘅成交實用呎價中位數做基準，再按樓層、座向、景觀同裝修調整；同屋苑成交少時，可以參考附近相近樓齡嘅屋苑。"))
        faqs.append((f"可唔可以追蹤{name}屋苑嘅減價？", "可以。免費註冊搵樓日記並追蹤屋苑之後，系統每日自動記低每個盤嘅放盤日數、每次改價同下架去向，並同屋苑成交中位數比較。"))
    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "WebPage", "name": f"{name}{'租樓：四大地產網最新租盤一次睇' if rent else '二手樓：四大地產網最新放盤一次睇'}", "url": url, "inLanguage": "zh-HK",
         "about": {"@type": "Place", "name": name if name.endswith("區") else name + "區",
                   "address": {"@type": "PostalAddress", "addressRegion": d["region"], "addressCountry": "HK"}}},
        {"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "搵樓日記", "item": BASE + "/"},
            {"@type": "ListItem", "position": 2, "name": "各區樓盤", "item": BASE + "/area/"},
            {"@type": "ListItem", "position": 3, "name": f"{name}{noun}", "item": url}]},
        {"@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faqs]}]}
    rows = "\n".join(
        f'        <tr><td>{e(sub)}</td><td>{e(mtr)}</td><td>' +
        ("、".join(f'<a href="{kw(x, rent)}">{e(x)}</a>' for x in ests) if ests else '<span style="color:var(--muted)">以單幢樓、村屋或者公營房屋為主</span>') +
        '</td></tr>' for sub, mtr, ests in d["rows"])
    tip_list = (RENT[c][1] + RENT_TIPS_COMMON) if rent else d["tips"]
    tips = "\n".join(f'        <li><b>{e(t)}</b>：{linkify(x)}</li>' for t, x in tip_list)
    if rent:
        chips = [f'<a href="/area/{d["slug"]}">{e(name)}二手樓（買盤）</a>'] + [f'<a href="/area/{SLUG[n]}-rent">{e(NAME[n])}租盤</a>' for n in d["neighbours"]]
    else:
        chips = [f'<a href="/area/{d["slug"]}-rent">{e(name)}租盤</a>'] + [f'<a href="/area/{SLUG[n]}">{e(NAME[n])}二手樓</a>' for n in d["neighbours"]]
    intro_html = e(d["intro"]) if not rent else (e(RENT[c][0]) + "<br><br>" + e(d["intro"]))
    h1 = f"{name}租樓：四大地產網最新租盤一次睇" if rent else f"{name}二手樓：四大地產網最新放盤一次睇"
    eg = "、".join(f'<a href="{kw(x, rent)}">{e(x)}</a>' for x in top)
    faq_html = "\n".join(f'    <details><summary>{e(q)}</summary><p>{e(a)}</p></details>' for q, a in faqs)
    return f'''<!DOCTYPE html>
<html lang="zh-HK">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>{e(name)}{"租盤｜中原、美聯、香港置業、利嘉閣租樓放盤一次睇" if rent else "二手樓｜中原、美聯、香港置業、利嘉閣最新放盤一次睇"} — 搵樓日記</title>
  <meta name="description" content="{e(desc)}">
  <link rel="canonical" href="{url}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="搵樓日記">
  <meta property="og:locale" content="zh_HK">
  <meta property="og:url" content="{url}">
  <meta property="og:title" content="{e(h1)}">
  <meta property="og:description" content="{e(subs)}{'租盤，月租' if rent else '買盤，價錢'}由低至高即時搵晒。免登入。">
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
  <nav class="crumb" aria-label="麵包屑"><a href="/">搵樓日記</a> › <a href="/area/">各區樓盤</a> › {e(name)}{noun}</nav>
  <h1>{e(h1)}</h1>
  <p class="area-intro">{intro_html}</p>

  <section class="area-sec">
    <h2>{e(name)}分區、港鐵站同屋苑</h2>
    <div class="area-table-wrap">
      <table class="area-table">
        <tr><th>分區</th><th>交通</th><th>屋苑例子（撳一下即搜）</th></tr>
{rows}
      </table>
    </div>
  </section>

  <section class="area-sec">
    <details class="area-group">
      <summary><h2>喺{e(name)}{"租樓" if rent else "買樓"}要留意乜？</h2></summary>
      <ul>
{tips}
      </ul>
    </details>
  </section>

  <section class="area-sec" style="margin-top:2.2rem">
    <h2>{e(name)}最新{"租盤" if rent else "買盤"}（即時）</h2>
    <p style="color:var(--muted);margin:0 0 0.4rem">四大地產網而家喺{e(name)}放緊嘅{"租盤，月租" if rent else "盤，"}由平到貴排{("；想睇某個屋苑，喺「屋苑」格輸入名，例如" + eg) if eg else ""}。</p>
  </section>
  <!-- 即時搜尋（同 /search 共用 public-search.js），預設{e(name)}（area {c}） -->
  <div id="area-search"></div>

  <section class="area-sec">
    <h2>{"買盤同附近地區租盤" if rent else e(name) + "租盤同附近地區"}</h2>
    <div class="area-chips">
      {chr(10).join("      " + x for x in chips).strip()}
      <a href="/area/">全港各區</a>
    </div>
  </section>

  <section class="area-sec">
    <h2>常見問題</h2>
{faq_html}
  </section>

  <p class="ps-note">放盤資料即時來自各地產代理網站，由第三方提供，搵樓日記唔保證準確，實際情況請向代理核實。<br>搵樓日記唔係地產代理，唔儲存搜尋結果。</p>
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
  // 嵌入模式（唔改網址／標題），預設{e(name)}；保留「免費登記追蹤」提示
  window.PublicSearch.mount(document.getElementById("area-search"), {{ embedded: true, hook: true, initial: {{ {'deal: "R", ' if rent else ''}area: "{c}" }} }});
</script>
</body>
</html>
'''


def hub():
    regions = ["港島", "九龍", "新界", "離島"]
    blocks = []
    for r in regions:
        items = [d for d in D.values() if d["region"] == r]
        lis = "\n".join(
            f'      <li><a class="card-link" href="/area/{d["slug"]}"><b>{e(d["name"])}二手樓</b>'
            f'<span>{e("、".join(x[0].replace("・", "、") for x in d["rows"]))}</span></a>'
            f'<a class="area-hub-rent" href="/area/{d["slug"]}-rent">{e(d["name"])}租盤 →</a></li>' for d in items)
        blocks.append(f'    <h2>{r}</h2>\n    <ul class="card-list">\n{lis}\n    </ul>')
    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "CollectionPage", "name": "香港各區二手樓放盤", "url": f"{BASE}/area/", "inLanguage": "zh-HK"},
        {"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "搵樓日記", "item": BASE + "/"},
            {"@type": "ListItem", "position": 2, "name": "各區樓盤", "item": BASE + "/area/"}]}]}
    return f'''<!DOCTYPE html>
<html lang="zh-HK">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>香港各區二手樓同租盤｜港島、九龍、新界 19 區一次睇 — 搵樓日記</title>
  <meta name="description" content="按地區搵二手樓：港島、九龍、新界同離島 19 區，每區有分區、港鐵站同主要屋苑一覽，同埋中原、美聯、香港置業、利嘉閣最新放盤即時搜尋。免登入。">
  <link rel="canonical" href="{BASE}/area/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="搵樓日記">
  <meta property="og:locale" content="zh_HK">
  <meta property="og:url" content="{BASE}/area/">
  <meta property="og:title" content="香港各區二手樓放盤一次睇">
  <meta property="og:description" content="19 區分區、港鐵站、主要屋苑，同四大地產網最新放盤。">
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

<main class="wrap">
  <nav class="crumb" aria-label="麵包屑"><a href="/">搵樓日記</a> › 各區樓盤</nav>
  <h1>香港各區二手樓同租盤</h1>
  <style>.area-hub-rent{{display:inline-block;margin:0.35rem 0 0 0.2rem;font-size:0.86rem;color:var(--accent2)}}</style>
  <p class="lead">揀地區，就睇到嗰區嘅分區、港鐵站同主要屋苑，同埋中原、美聯、香港置業、利嘉閣最新買盤同租盤（價錢由低至高）。想直接搜尋，可以用<a href="/search">四網一次搜</a>。</p>
  <div class="content">
{chr(10).join(blocks)}
  </div>
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
</body>
</html>
'''


CSS = '''/* 地區專頁（/area/*）共用樣式 */
.area-intro { color: var(--muted); font-size: 0.95rem; line-height: 1.85; margin: 0.4rem 0 1rem; }
.area-sec { margin: 2.2rem 0 0; font-size: 0.92rem; line-height: 1.85; color: var(--text); }
.area-sec h2 { font-size: 1.15rem; margin: 0 0 0.6rem; }
.area-sec a { color: var(--accent2); }
.area-table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); }
.area-table { width: 100%; border-collapse: collapse; min-width: 520px; font-size: 0.88rem; }
.area-table th { background: var(--surface2); color: var(--muted); text-align: left; padding: 0.55rem 0.8rem; font-size: 0.8rem; }
.area-table td { padding: 0.6rem 0.8rem; border-top: 1px solid var(--border); vertical-align: top; }
.area-chips { display: flex; flex-wrap: wrap; gap: 0.45rem; }
.area-chips a { background: var(--surface); border: 1px solid var(--border-strong, rgba(30,80,130,0.22)); border-radius: 999px; padding: 0.25rem 0.75rem; text-decoration: none; color: var(--text); font-size: 0.86rem; }
.area-sec details { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 0.7rem 1rem; margin-bottom: 0.5rem; }
.area-sec summary { cursor: pointer; font-weight: 700; }
.area-sec details p { margin: 0.45rem 0 0; color: var(--muted); }
.area-group { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 0.8rem 1.1rem; }
.area-sec details.area-group { padding: 0.8rem 1.1rem; margin: 0; }
.area-group > summary { cursor: pointer; list-style: revert; }
.area-group > summary h2 { display: inline; margin: 0; font-size: 1.15rem; }
.area-group[open] > summary { margin-bottom: 0.4rem; }
.area-group ul { margin: 0.2rem 0; padding-left: 1.2rem; }
.area-group li { margin: 0.35rem 0; }
'''

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    open(os.path.join(OUT, "area.css"), "w").write(CSS)
    for d in D.values():
        open(os.path.join(OUT, d["slug"] + ".html"), "w").write(page(d))
        open(os.path.join(OUT, d["slug"] + "-rent.html"), "w").write(page(d, "R"))
    open(os.path.join(OUT, "index.html"), "w").write(hub())
    print("pages:", len(D), "買盤 +", len(D), "租盤 + hub")
