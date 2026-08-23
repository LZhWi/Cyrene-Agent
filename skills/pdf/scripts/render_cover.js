#!/usr/bin/env node
/**
 * render_cover.js — Render cover.html → cover.pdf via Playwright.
 *
 * Usage:
 *   node render_cover.js --input cover.html --out cover.pdf
 *   node render_cover.js --input cover.html --out cover.pdf --wait 1200
 *   node render_cover.js --probe          # 仅检测 playwright 可用性（make.sh check 用）
 *
 * Playwright 加载链（兼容开发 / 打包 / 全局安装三种环境）：
 *   1. 标准 require 解析（开发：脚本在 <project>/skills/pdf/scripts，
 *      向上三层即项目根的 node_modules）
 *   2. 打包环境：脚本在 <install>/resources/skills/pdf/scripts，向上三层即
 *      resources/，playwright 已由 electron-builder asarUnpack 落盘到
 *      app.asar.unpacked/node_modules（真实磁盘文件，
 *      ELECTRON_RUN_AS_NODE 模式下可读）
 *   3. npm root -g 全局安装（兜底）
 *
 * 浏览器：优先系统 Edge（channel msedge，Windows 自带，零下载），
 * 失败回落已下载的 Chromium（开发环境 npx playwright install chromium）。
 *
 * Exit codes: 0 success, 1 bad args, 2 dependency missing, 3 render error
 */

const path = require("path");
const fs   = require("fs");

function usage() {
  console.error("Usage: node render_cover.js --input <file.html> --out <file.pdf> [--wait <ms>]");
  console.error("       node render_cover.js --probe");
  process.exit(1);
}

// ── Arg parsing ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let inputFile = null, outFile = null, waitMs = 800, probe = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--input" && args[i + 1]) { inputFile = args[++i]; }
  else if (args[i] === "--out"   && args[i + 1]) { outFile   = args[++i]; }
  else if (args[i] === "--wait"  && args[i + 1]) { waitMs    = parseInt(args[++i], 10); }
  else if (args[i] === "--probe")               { probe     = true; }
}

if (!probe && (!inputFile || !outFile)) usage();
if (!probe && !fs.existsSync(inputFile)) {
  console.error(JSON.stringify({ status: "error", error: `File not found: ${inputFile}` }));
  process.exit(1);
}

// ── Playwright loader (dev / packaged / global npm) ───────────────────────────
function loadPlaywright() {
  // 1. 标准 require（开发环境：项目 node_modules）
  try { return require("playwright"); } catch (_) {}

  // 2. 打包环境：app.asar.unpacked 里随应用分发的 playwright
  const unpacked = path.resolve(__dirname, "..", "..", "..",
    "app.asar.unpacked", "node_modules", "playwright");
  if (fs.existsSync(path.join(unpacked, "package.json"))) {
    try { return require(unpacked); } catch (_) {}
  }

  // 3. 全局 npm 安装兜底
  try {
    const { execSync } = require("child_process");
    const root = execSync("npm root -g", { stdio: ["ignore","pipe","ignore"] }).toString().trim();
    return require(path.join(root, "playwright"));
  } catch (_) {}

  console.error(JSON.stringify({
    status: "error",
    error: "playwright not found",
    hint: "打包版随应用自带（重装应用可修复）；开发环境运行: npm install -g playwright"
  }));
  process.exit(2);
}

// ── Browser launcher: 系统 Edge 优先，Chromium 回落 ──────────────────────────
async function launchBrowser(chromium) {
  // Windows 自带 Edge，无需下载浏览器（与 Playwright MCP 同策略）
  try { return await chromium.launch({ channel: "msedge" }); } catch (_) {}
  // 开发环境已下载的 Chromium
  try { return await chromium.launch(); } catch (_) {}
  console.error(JSON.stringify({
    status: "error",
    error: "no usable browser (Edge / Chromium)",
    hint: "Windows 自带 Edge 应可用；开发环境可运行: npx playwright install chromium"
  }));
  process.exit(2);
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  const { chromium } = loadPlaywright();

  if (probe) {
    console.log(JSON.stringify({ status: "ok", engine: "playwright" }));
    process.exit(0);
  }

  const browser = await launchBrowser(chromium);

  try {
    const page = await browser.newPage();
    const fileUrl = "file://" + path.resolve(inputFile);
    await page.goto(fileUrl);
    await page.waitForTimeout(waitMs);   // let CSS + any JS settle

    await page.pdf({
      path:            outFile,
      width:           "794px",
      height:          "1123px",
      printBackground: true,
    });

    await browser.close();

    // Basic sanity: output file must exist and be > 5 KB
    const stat = fs.statSync(outFile);
    if (stat.size < 5000) {
      console.error(JSON.stringify({
        status: "error",
        error: "Output PDF is suspiciously small — cover may be blank",
        hint:  "Check cover.html for render errors"
      }));
      process.exit(3);
    }

    console.log(JSON.stringify({
      status: "ok",
      out:    outFile,
      size_kb: Math.round(stat.size / 1024),
    }));

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    console.error(JSON.stringify({ status: "error", error: String(e) }));
    process.exit(3);
  }
})();
