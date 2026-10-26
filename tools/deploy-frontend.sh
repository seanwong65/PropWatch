#!/usr/bin/env bash
# 前端 deploy（2026-10-27 起一律用呢個）：先 build（刪註解＋壓縮＋語法檢查）再上載 dist-frontend/。
# 直接 deploy frontend/ 會將所有內部註解原封不動送俾用戶，唔好咁做。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/tools" && [ -d node_modules ] || npm install --silent
cd "$ROOT"
node tools/build-frontend.mjs
TMPDIR=/tmp npx wrangler pages deploy dist-frontend --project-name=propwatch --branch=main --commit-dirty=true
