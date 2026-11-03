"""更新 frontend/sitemap.xml 嘅 <lastmod>（2026-11-03）：每個 URL 對應嘅 html 檔，有未 commit 改動就用今日，否則用最後一次 commit 日期。
Google 只信「準確」嘅 lastmod，全部寫同一日等於冇用。加／刪頁面仍然要手動改 sitemap 嘅 <url>。用法：python3 tools/seo/sitemap_lastmod.py（commit 前行）"""
import re, os, subprocess, datetime

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
FE = os.path.join(ROOT, "frontend")
SM = os.path.join(FE, "sitemap.xml")
BASE = "https://home.ws-techs.com"
today = (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).strftime("%Y-%m-%d")


def src(path):
    if path == "/": return "index.html"
    if path.endswith("/"): return path.strip("/") + "/index.html"
    return path.strip("/") + ".html"


def git(*a): return subprocess.run(["git", "-C", ROOT, *a], capture_output=True, text=True).stdout.strip()


dirty = {l[3:].strip() for l in git("status", "--porcelain").splitlines()}
s = open(SM, encoding="utf-8").read()


def fix(m):
    loc = m.group(1); f = "frontend/" + src(loc[len(BASE):])
    assert os.path.exists(os.path.join(ROOT, f)), f
    d = today if f in dirty else (git("log", "-1", "--format=%cs", "--", f) or today)
    return f"<loc>{loc}</loc>\n    <lastmod>{d}</lastmod>"


s2 = re.sub(r"<loc>([^<]+)</loc>\s*<lastmod>[^<]*</lastmod>", fix, s)
open(SM, "w", encoding="utf-8").write(s2)
print("lastmod updated:", len(re.findall("<lastmod>", s2)))
