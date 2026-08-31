// QQ 音乐本地安装检测。
//
// 设置页要回答三个不同的问题，别混为一谈：
//   1. 装没装        → 注册表卸载项（装了但没开也能查到）
//   2. 开没开        → SMTC 有没有它的会话
//   3. 能不能控制    → 上面两条 + cyrene-media.exe 在位
// 三者独立：装了没开 → 提示用户打开；开了但 helper 缺失 → 提示重新构建。
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { QQ_MUSIC_APP_ID, SmtcController } from "./smtc-controller";

// 注册表路径用 String.raw：普通字符串里 "\S" "\M" 这些会被当成转义吃掉，
// 结果是 reg.exe 收到 "HKLMSOFTWARE..." 然后报 Invalid key name。
/** 实测存在的卸载项键名（QQ 音乐 21.11）。 */
const UNINSTALL_KEY = String.raw`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\QQMusic`;

/** 注册表查不到时的兜底路径。正斜杠在 Windows 上一样有效，且不会踩转义。 */
const FALLBACK_EXES = [
  "C:/Program Files (x86)/Tencent/QQMusic/QQMusic.exe",
  "C:/Program Files/Tencent/QQMusic/QQMusic.exe",
];

export interface QQMusicNowPlaying {
  title: string;
  artist: string;
  album: string;
  status: string;
}

export interface QQMusicDetection {
  installed: boolean;
  installPath: string | null;
  version: string | null;
  /** SMTC 里有它的会话 = 正在运行且可被控制。 */
  running: boolean;
  /** cyrene-media.exe 是否已构建并就位。 */
  helperAvailable: boolean;
  /** 三个条件都满足才算真正可用。 */
  controllable: boolean;
  nowPlaying: QQMusicNowPlaying | null;
}

/** reg.exe 输出解析：`    ValueName    REG_SZ    value`。 */
function readRegValue(output: string, name: string): string | null {
  const re = new RegExp(String.raw`^\s+${name}\s+REG_\w+\s+(.*)$`, "im");
  const m = re.exec(output);
  const value = m?.[1]?.trim();
  return value ? value : null;
}

function queryUninstallKey(view: "32" | "64"): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "reg.exe",
      ["query", UNINSTALL_KEY, `/reg:${view}`],
      { timeout: 4000, windowsHide: true },
      // 键不存在时 reg.exe 以非 0 退出，这不是错误，只是"没装"。
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

async function detectInstall(): Promise<Pick<QQMusicDetection, "installed" | "installPath" | "version">> {
  for (const view of ["32", "64"] as const) {
    const out = await queryUninstallKey(view);
    if (!out) continue;
    // DisplayName 是中文，受控制台代码页影响可能是乱码，所以只读这两个 ASCII 值。
    const installPath = readRegValue(out, "InstallLocation");
    const version = readRegValue(out, "DisplayVersion");
    if (installPath || version) {
      return { installed: true, installPath, version };
    }
  }
  // 注册表没有（绿色版/自定义安装）→ 退回已知路径。
  const hit = FALLBACK_EXES.find((p) => fs.existsSync(p));
  return hit
    ? { installed: true, installPath: hit.replace(/\/QQMusic\.exe$/i, ""), version: null }
    : { installed: false, installPath: null, version: null };
}

export async function detectQQMusic(
  controller: SmtcController = new SmtcController(),
): Promise<QQMusicDetection> {
  const install = await detectInstall();
  const helperAvailable = controller.isAvailable();

  let session = null;
  if (helperAvailable) {
    // helper 在位但 SMTC 查询失败（播放器没开等）不该让整个检测失败。
    try {
      session = await controller.findSession(QQ_MUSIC_APP_ID);
    } catch {
      session = null;
    }
  }

  return {
    ...install,
    running: session !== null,
    helperAvailable,
    controllable: install.installed && helperAvailable && session !== null,
    nowPlaying: session && session.title
      ? { title: session.title, artist: session.artist, album: session.album, status: session.playbackStatus }
      : null,
  };
}
