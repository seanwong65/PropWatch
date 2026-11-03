"""教學頁「相關教學」區塊（內部連結，2026-11-03）。可重覆行：區塊夾喺 <!--related-->…<!--/related--> 之間，再行會覆蓋。
用法：python3 tools/seo/related.py   （改 RELATED／LABEL 後重行，再 build／commit）
新加教學：LABEL 加一行短標題、RELATED 加 3 個相關 slug，並喺 guides/index.html 同 sitemap 加返。"""
import re, os, html

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "frontend", "guides")
e = html.escape
LABEL = {
    "listing-days": ("點知一個盤放咗幾耐？", "放盤日數、減價歷史點睇"),
    "asking-vs-transaction": ("叫價同成交價差幾多先算抵？", "用成交中位數判斷貴定平"),
    "viewing-checklist": ("睇樓清單", "睇樓要注意乜"),
    "negotiation": ("買樓點樣講價？", "用放盤日數、減價紀錄、成交價做籌碼"),
    "hos-premium": ("居屋未補地價點計？", "補地價計法、第二市場、綠表白表"),
    "renting-checklist": ("租樓注意事項", "按金、佣金、租約印花稅、生約死約"),
    "saleable-area": ("實用面積同建築面積", "實用率點計、呎價點比較"),
    "buying-process": ("買二手樓流程", "由睇樓、出價、簽約到收樓"),
    "extra-costs": ("買樓除咗首期仲要預幾多錢？", "印花稅、律師費、佣金、按保、裝修"),
    "bank-valuation": ("銀行估價點查？", "估價唔夠成交價點算"),
    "old-building": ("買舊樓要留意乜？", "樓齡、大維修、強制驗樓、按揭年期"),
    "floor-and-orientation": ("樓層、座向、西斜、景觀點揀？", "同一屋苑差價點解咁大"),
    "unauthorised-works": ("單位有僭建點算？", "點識別、對按揭同轉售嘅影響"),
    "transaction-records": ("點睇樓盤成交紀錄？", "註冊日期、中位數、呎價點解讀"),
    "h-vs-p-mortgage": ("H按定P按？", "兩種按揭計法、封頂息率、罰息期"),
    "rent-or-buy": ("租樓定買樓好？", "用數字比較，唔好只計月供同租金"),
}
RELATED = {
    "listing-days": ["asking-vs-transaction", "negotiation", "transaction-records"],
    "asking-vs-transaction": ["transaction-records", "negotiation", "bank-valuation"],
    "viewing-checklist": ["floor-and-orientation", "saleable-area", "unauthorised-works"],
    "negotiation": ["asking-vs-transaction", "bank-valuation", "listing-days"],
    "hos-premium": ["buying-process", "extra-costs", "bank-valuation"],
    "renting-checklist": ["rent-or-buy", "viewing-checklist", "unauthorised-works"],
    "saleable-area": ["floor-and-orientation", "viewing-checklist", "asking-vs-transaction"],
    "buying-process": ["extra-costs", "bank-valuation", "h-vs-p-mortgage"],
    "extra-costs": ["buying-process", "h-vs-p-mortgage", "rent-or-buy"],
    "bank-valuation": ["h-vs-p-mortgage", "negotiation", "extra-costs"],
    "old-building": ["unauthorised-works", "viewing-checklist", "floor-and-orientation"],
    "floor-and-orientation": ["saleable-area", "viewing-checklist", "old-building"],
    "unauthorised-works": ["old-building", "viewing-checklist", "buying-process"],
    "transaction-records": ["asking-vs-transaction", "listing-days", "negotiation"],
    "h-vs-p-mortgage": ["bank-valuation", "buying-process", "extra-costs"],
    "rent-or-buy": ["renting-checklist", "extra-costs", "buying-process"],
}
TOOLS = '<p class="related-tools">用工具：<a href="/mortgage-calculator">按揭計算機</a>・<a href="/search">四大地產網一次搜</a>・<a href="/area/">各區樓盤</a>・<a href="/estate/">屋苑數據</a>・<a href="/guides/">全部教學</a></p>'


def block(slug):
    items = "".join(f'<li><a href="/guides/{s}"><b>{e(LABEL[s][0])}</b><small>{e(LABEL[s][1])}</small></a></li>' for s in RELATED[slug])
    return f'<!--related-->\n    <section class="related" aria-label="相關教學">\n      <h2>睇埋呢幾篇</h2>\n      <ul>{items}</ul>\n      {TOOLS}\n    </section>\n    <!--/related-->'


for slug in RELATED:
    assert slug in LABEL and all(s in LABEL and s != slug for s in RELATED[slug]), slug
    p = os.path.join(ROOT, slug + ".html")
    s = open(p, encoding="utf-8").read()
    b = block(slug)
    if "<!--related-->" in s:
        s = re.sub(r"<!--related-->.*?<!--/related-->", lambda m: b, s, flags=re.S)
    else:
        assert s.count('<section class="cta">') == 1, slug
        s = s.replace('<section class="cta">', b + '\n\n    <section class="cta">')
    open(p, "w", encoding="utf-8").write(s)
print("ok", len(RELATED))
