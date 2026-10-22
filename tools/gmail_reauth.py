#!/usr/bin/env python3
"""重新授權 worker 寄信用嘅 Gmail（hkbuyhouse@gmail.com），直接寫入 worker secret。

幾時用：worker log 見到 `gmail token error 400 ... invalid_grant`（refresh token
過期／被撤銷，例如改過 Google 密碼），即係成個系統寄唔到信。

用法（喺 PropWatch root）：python3 tools/gmail_reauth.py

- 要用 Google Cloud 入面「Desktop」類型嘅 OAuth client（project friendly-storm-502210-j6，
  Google Auth Platform → Clients）。Desktop client 嘅 loopback redirect（127.0.0.1:任意 port）
  唔使預先登記。睇唔到 secret 就喺 client 頁 Add secret 開個新嘅。
- Client secret 同 refresh token 都唔會顯示喺畫面、唔會寫落任何檔案，淨係經 stdin
  交俾 `wrangler secret put`（GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN
  三個一齊換，保證三者屬同一個 client）。
"""
import base64
import getpass
import hashlib
import http.server
import json
import os
import secrets
import subprocess
import sys
import urllib.parse
import urllib.request
import webbrowser

SCOPE = "https://www.googleapis.com/auth/gmail.send"
SENDER = "hkbuyhouse@gmail.com"
WORKER_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker"))


def post_form(url, data):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(),
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        sys.exit(f"❌ Google 回 {e.code}：{body[:300]}")


def main():
    cid = input("Desktop client 嘅 Client ID: ").strip()
    csec = getpass.getpass("Client secret（輸入時唔會顯示）: ").strip()
    if not cid.endswith(".apps.googleusercontent.com") or not csec:
        sys.exit("❌ Client ID／secret 格式唔啱")

    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    result = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            ok = q.get("state", [""])[0] == state and ("code" in q or "error" in q)
            if ok:
                result["code"] = q.get("code", [""])[0]
                result["error"] = q.get("error", [""])[0]
            self.send_response(200 if ok else 400)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            msg = "完成，可以閂咗呢頁，返去 terminal。" if ok else "無效請求"
            self.wfile.write(f"<p style='font:18px sans-serif'>{msg}</p>".encode())

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    redirect = f"http://127.0.0.1:{srv.server_port}"
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": cid, "redirect_uri": redirect, "response_type": "code", "scope": SCOPE,
        "access_type": "offline", "prompt": "consent", "state": state, "login_hint": SENDER,
        "code_challenge": challenge, "code_challenge_method": "S256",
    })
    print(f"\n開緊瀏覽器 → 用 {SENDER} 登入並允許「傳送電郵」。")
    print("冇自動開到就 copy 呢條 link 去瀏覽器：\n" + url + "\n")
    webbrowser.open(url)
    while not result:
        srv.handle_request()
    srv.server_close()
    if result["error"] or not result["code"]:
        sys.exit(f"❌ 授權失敗：{result['error'] or '冇 code'}")

    tok = post_form("https://oauth2.googleapis.com/token", {
        "client_id": cid, "client_secret": csec, "code": result["code"], "grant_type": "authorization_code",
        "redirect_uri": redirect, "code_verifier": verifier,
    })
    rt = tok.get("refresh_token")
    if not rt:
        sys.exit("❌ Google 冇俾 refresh token（試吓去 myaccount.google.com/permissions 移除 PropWatch 授權再行過）")
    # 用新 refresh token 試換一次 access token，確認可用先寫入 worker
    post_form("https://oauth2.googleapis.com/token", {
        "client_id": cid, "client_secret": csec, "refresh_token": rt, "grant_type": "refresh_token",
    })
    print("✅ 新 token 驗證通過，寫入 worker secret…")
    for name, val in (("GMAIL_CLIENT_ID", cid), ("GMAIL_CLIENT_SECRET", csec), ("GMAIL_REFRESH_TOKEN", rt)):
        r = subprocess.run(["npx", "wrangler", "secret", "put", name], input=val + "\n", text=True,
                           cwd=WORKER_DIR, capture_output=True)
        if r.returncode != 0:
            sys.exit(f"❌ 寫入 {name} 失敗：{(r.stderr or r.stdout)[-300:]}")
        print(f"  ✓ {name}")
    print("\n完成！話返 Claude 知，佢會寄封測試信確認。")


if __name__ == "__main__":
    main()
