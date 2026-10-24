#!/usr/bin/env bash
# 前端靜態檢查：抽出 app.html／index.html 等嘅 inline <script>，行 node --check（語法）＋ eslint no-undef（未定義變數／函數）。
# 呢個檢查會捉到「函數被刪咗但呼叫位仲喺度」（2026-10-25 priceRulerSampleHtml 事故：免費用戶睇樓詳情永遠載入中）。
# 用法：bash tests/regression/check-frontend.sh   （要網絡：npx 會裝 eslint@9 去 temp）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
python3 - "$ROOT" "$TMP" <<'PY'
import re,sys,os
root,tmp=sys.argv[1:3]
for name in ["app.html","index.html","search.html"]:
    p=os.path.join(root,"frontend",name)
    if not os.path.exists(p): continue
    s=open(p,encoding="utf-8").read()
    js="\n;\n".join(x for x in re.findall(r"<script(?![^>]*\bsrc=)(?![^>]*type=\"application/ld)[^>]*>(.*?)</script>",s,re.S))
    open(os.path.join(tmp,name.replace(".html",".js")),"w").write(js)
PY
cat > "$TMP/eslint.config.mjs" <<'EOF2'
const g = Object.fromEntries("window document localStorage sessionStorage fetch navigator location console setTimeout clearTimeout setInterval clearInterval URL URLSearchParams FormData Blob Image FileReader Promise requestAnimationFrame cancelAnimationFrame alert confirm prompt history performance getComputedStyle matchMedia Intl CSS Chart btoa atob AbortController IntersectionObserver ResizeObserver MutationObserver HTMLElement HTMLVideoElement HTMLImageElement HTMLCanvasElement Event CustomEvent File createImageBitmap Notification screen innerWidth innerHeight scrollTo open print structuredClone TextEncoder TextDecoder crypto caches DOMParser XMLHttpRequest queueMicrotask Element Node KeyboardEvent MouseEvent TouchEvent getSelection Option ClipboardItem DataTransfer Headers Response Request visualViewport scrollY scrollX pageYOffset top parent self outerWidth devicePixelRatio gtag dataLayer".split(" ").map(k=>[k,"readonly"]));
export default [{ files:["*.js"], languageOptions:{ ecmaVersion:2023, sourceType:"script", globals:{...g, mountMortgageForm:"readonly", renderMortgage:"readonly", setMcMode:"readonly"} }, rules:{ "no-undef":"error" } }];
EOF2
cd "$TMP"; fail=0
for f in *.js; do
  [ -s "$f" ] || continue
  node --check "$f" || fail=1
  npx --yes eslint@9 "$f" || fail=1
done
[ $fail = 0 ] && echo "前端靜態檢查通過" || { echo "前端靜態檢查失敗"; exit 1; }
