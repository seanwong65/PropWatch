#!/usr/bin/env node
// 前端 build（2026-10-27）：frontend/ → dist-frontend/，上載前刪晒註解＋壓縮。
// 目的：防人「檢視原始碼」直接睇到內部設計註解（endpoint、安全考量、D1 細節），同埋令抄 script 難啲。
// repo 入面嘅 frontend/ 保持可讀；deploy 一律用 dist-frontend/（見 tools/deploy-frontend.sh）。
//   - *.html：刪 HTML 註解、壓縮 inline <script>（terser，唔改 top-level 名，onclick 照用得）／inline <style>
//             JSON-LD（application/ld+json）唔郁；Google 驗證檔原封不動
//   - *.js：terser（local 變數改短名、刪註解；top-level／全域名唔改，其他頁面靠佢哋）
//   - *.css：clean-css
//   - JS 字串入面嘅 HTML 註解（template literal 入面寫嘅 <!-- … -->）一併刪走
// 完成後檢查：所有 inline script 語法正確，否則 exit 1（唔好上載爛咗嘅版本）。
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { minify: minifyHtml } = require("html-minifier-terser");
const { minify: minifyJs } = require("terser");
const CleanCSS = require("clean-css");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "frontend"), OUT = path.join(ROOT, "dist-frontend");
const TERSER = { compress: { passes: 1 }, mangle: { toplevel: false }, format: { comments: false } };
const stripHtmlCommentsInStrings = (s) => s.replace(/<!--(?!\[)[\s\S]*?-->/g, "");

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}

await fs.rm(OUT, { recursive: true, force: true });
let before = 0, after = 0;
const sizes = [];
for (const file of await walk(SRC)) {
  const rel = path.relative(SRC, file), dest = path.join(OUT, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const ext = path.extname(file);
  const raw = await fs.readFile(file);
  let outBuf = raw;
  if (ext === ".html" && !path.basename(file).startsWith("google")) {
    const html = await minifyHtml(raw.toString("utf8"), {
      removeComments: true, collapseWhitespace: true, conservativeCollapse: true,
      minifyCSS: true, minifyJS: TERSER, decodeEntities: false, keepClosingSlash: true,
      removeRedundantAttributes: false, removeAttributeQuotes: false, caseSensitive: true,
    });
    outBuf = Buffer.from(stripHtmlCommentsInStrings(html));
  } else if (ext === ".js") {
    const r = await minifyJs(raw.toString("utf8"), TERSER);
    outBuf = Buffer.from(stripHtmlCommentsInStrings(r.code));
  } else if (ext === ".css") {
    const r = new CleanCSS({ level: 1 }).minify(raw.toString("utf8"));
    if (r.errors.length) throw new Error(`${rel}: ${r.errors.join("; ")}`);
    outBuf = Buffer.from(r.styles);
  }
  await fs.writeFile(dest, outBuf);
  if ([".html", ".js", ".css"].includes(ext)) { before += raw.length; after += outBuf.length; sizes.push([rel, raw.length, outBuf.length]); }
}

// 檢查：每個 HTML 嘅 inline script 都要語法正確
const tmp = await fs.mkdtemp(path.join(process.env.TMPDIR || "/tmp", "pwbuild-"));
let bad = 0;
for (const [rel] of sizes.filter(([r]) => r.endsWith(".html") || r.endsWith(".js"))) {
  const text = await fs.readFile(path.join(OUT, rel), "utf8");
  const scripts = rel.endsWith(".js") ? [text]
    : [...text.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const [i, js] of scripts.entries()) {
    const f = path.join(tmp, `${rel.replace(/[\\/]/g, "_")}.${i}.js`);
    await fs.writeFile(f, js);
    try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); }
    catch (e) { bad++; console.error(`語法錯誤：${rel} script #${i}\n${e.stderr?.toString().slice(0, 400)}`); }
  }
}
await fs.rm(tmp, { recursive: true, force: true });
for (const [rel, a, b] of sizes.sort((x, y) => y[1] - x[1]).slice(0, 6)) console.log(`${rel.padEnd(28)} ${(a / 1024).toFixed(0).padStart(5)}KB → ${(b / 1024).toFixed(0).padStart(4)}KB`);
console.log(`總共 ${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB（${Math.round((1 - after / before) * 100)}% 細咗）`);
if (bad) { console.error(`❌ ${bad} 個 script 語法錯誤，唔好 deploy`); process.exit(1); }
console.log("✅ build OK → dist-frontend/");
