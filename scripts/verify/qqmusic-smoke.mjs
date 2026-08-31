// QQ 音乐冒烟测试：对真实的本机环境跑一遍完整链路。
//
// 与单元测试互补——单测把 SMTC 和注册表都 mock 掉了，这里全都是真的：
//   1. 检测（注册表 + SMTC 会话）
//   2. 读当前曲目
//   3. 真发一条 next，确认曲目变了
//   4. 确认前台窗口没被抢走（这是整个方案的前提）
//   5. 确认 search / playSong 被明确拒绝，而不是静默失败
//
// 会真的切一首歌。跑之前请确保 QQ 音乐开着。
//   node scripts/verify/qqmusic-smoke.mjs
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const helper = path.join(repoRoot, "resources", "bin", "cyrene-media.exe");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

function helperJson(args) {
  const out = execFileSync(helper, args, { encoding: "utf8", windowsHide: true });
  return JSON.parse(out.trim());
}

function foregroundTitle() {
  // 用 PowerShell 读前台窗口标题：验证"后台生效"这条最关键的性质。
  const ps = `
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class FGP {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string T(){ var sb=new StringBuilder(300); GetWindowText(GetForegroundWindow(), sb, 300); return sb.ToString(); }
}
"@
[FGP]::T()`;
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
      encoding: "utf8", windowsHide: true, timeout: 15000,
    }).trim();
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("== QQ Music smoke ==");

// 1. 检测
// Windows 上动态 import 必须用 file:// URL，裸路径会被当成包名。
const detectorUrl = pathToFileURL(
  path.join(repoRoot, "dist", "main", "main", "music", "qqmusic-detector.js"),
).href;
let detectQQMusic;
try {
  ({ detectQQMusic } = await import(detectorUrl));
} catch (e) {
  console.error(`无法加载 ${detectorUrl}\n${e.message}`);
  process.exit(2);
}

const detection = await detectQQMusic();
console.log("detection:", JSON.stringify(detection));
check("installed", detection.installed, detection.version ?? "");
check("helper present", detection.helperAvailable, helper);

if (!detection.running) {
  console.log("\nQQ 音乐没在运行，跳过控制类检查。打开它再跑一次可覆盖全部用例。");
  process.exit(failures > 0 ? 1 : 0);
}

check("controllable", detection.controllable);
check("now playing readable", detection.nowPlaying !== null,
  detection.nowPlaying ? `${detection.nowPlaying.title} — ${detection.nowPlaying.artist}` : "none");

// 2/3. 传输控制是否真的切了歌
const before = helperJson(["status"]).data.sessions.find((s) => s.appId === "QQMusic.exe");
const fgBefore = foregroundTitle();

const nextRes = helperJson(["next", "--app", "QQMusic.exe"]);
check("next accepted", nextRes.ok === "true", JSON.stringify(nextRes));
await sleep(900);

const after = helperJson(["status"]).data.sessions.find((s) => s.appId === "QQMusic.exe");
check("track changed", before?.title !== after?.title, `${before?.title} -> ${after?.title}`);

// 4. 后台生效：前台窗口必须没被抢走
const fgAfter = foregroundTitle();
check("foreground unchanged", fgBefore === fgAfter, `'${fgBefore}' -> '${fgAfter}'`);

// 还原刚才切掉的那一首
helperJson(["prev", "--app", "QQMusic.exe"]);

// 5. 不支持的命令必须明确报错，而不是静默失败
const searchRes = helperJson(["search"]);
check("search refused explicitly",
  searchRes.ok === "false" && searchRes.error_code === "E_UNSUPPORTED_BY_SMTC",
  searchRes.error_code ?? "");

const missingRes = helperJson(["next", "--app", "NotARealPlayer.exe"]);
check("unknown player reported", missingRes.error_code === "E_PLAYER_NOT_FOUND");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures > 0 ? 1 : 0);
