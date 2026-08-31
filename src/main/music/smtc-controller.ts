// 外部播放器控制（QQ 音乐等）—— 通过 Windows SMTC，后台生效不弹窗。
//
// 为什么不是"接 QQ 音乐的 API"：QQ 音乐没有任何面向第三方的官方接口，
// 社区那些库全靠逆向请求签名，签名一换就废，而且违反其服务条款。
// SMTC（System Media Transport Controls）是 Windows 官方 API，几乎所有
// Windows 播放器都会注册一个会话，拿到的是：
//   - 传输控制：上一首 / 下一首 / 播放 / 暂停
//   - 正在播放的元数据：标题 / 歌手 / 专辑 / 播放状态
// 实测调用不会把播放器窗口带到前台（前台窗口在调用前后不变）。
//
// SMTC 明确**没有**的能力：搜索、歌单、按 ID 点播。这不是没做完，是这个
// API 就不提供——native 层遇到这类命令会回 E_UNSUPPORTED_BY_SMTC。
import { execFile } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

/** QQ 音乐在 SMTC 里的 AppUserModelId（实测值）。 */
export const QQ_MUSIC_APP_ID = "QQMusic.exe";

export type SmtcCommand = "next" | "prev" | "play" | "pause" | "toggle";

export interface SmtcSession {
  appId: string;
  playbackStatus: string;
  isCurrent: boolean;
  title: string;
  artist: string;
  album: string;
  canPlay: boolean;
  canPause: boolean;
  canNext: boolean;
  canPrev: boolean;
}

export class SmtcError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SmtcError";
  }
}

type HelperResult =
  | { ok: "true"; data: unknown }
  | { ok: "false"; error_code: string; message: string };

/**
 * 与 mpv-controller 相同的两段式查找：打包后在 resourcesPath，开发期在仓库。
 * 注意是上溯四级：编译产物在 dist/main/main/music/，少一级只会退到 dist/。
 */
function resolveHelperPath(): string | null {
  const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
  const candidates = [
    path.join(process.resourcesPath ?? "", "bin", "cyrene-media.exe"),
    path.join(repoRoot, "resources", "bin", "cyrene-media.exe"),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

export class SmtcController {
  constructor(private readonly helperPath: string | null = resolveHelperPath()) {}

  isAvailable(): boolean {
    return this.helperPath !== null;
  }

  /** 所有注册了 SMTC 会话的播放器。没有播放器在跑时返回空数组。 */
  async listSessions(): Promise<SmtcSession[]> {
    const data = await this.invoke(["status"]);
    const payload = data as { sessions?: SmtcSession[] };
    return payload.sessions ?? [];
  }

  /** 找某个播放器的会话；appId 大小写不敏感。 */
  async findSession(appId: string): Promise<SmtcSession | null> {
    const sessions = await this.listSessions();
    return sessions.find((s) => s.appId.toLowerCase() === appId.toLowerCase()) ?? null;
  }

  /**
   * 发一个传输指令。不传 appId 时作用于系统"当前会话"——
   * 但 Cyrene 自己用 mpv 放网易云，mpv 也会注册会话，所以调用方几乎总该
   * 显式指定 appId，否则可能把指令发给自己。
   */
  async control(command: SmtcCommand, appId?: string): Promise<void> {
    await this.invoke(appId ? [command, "--app", appId] : [command]);
  }

  private invoke(args: string[]): Promise<unknown> {
    const exe = this.helperPath;
    if (!exe) {
      return Promise.reject(new SmtcError("E_HELPER_MISSING", "cyrene-media.exe 未安装（运行 native/cyrene-media/stage.ps1 构建）"));
    }
    return new Promise((resolve, reject) => {
      execFile(exe, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err && !stdout) {
          reject(new SmtcError("E_HELPER_FAILED", err.message));
          return;
        }
        let parsed: HelperResult;
        try {
          parsed = JSON.parse(stdout.trim()) as HelperResult;
        } catch {
          reject(new SmtcError("E_HELPER_BAD_OUTPUT", stdout.slice(0, 200)));
          return;
        }
        if (parsed.ok === "false") {
          reject(new SmtcError(parsed.error_code, parsed.message));
          return;
        }
        resolve(parsed.data);
      });
    });
  }
}
