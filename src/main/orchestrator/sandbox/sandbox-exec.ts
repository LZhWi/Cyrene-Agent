// Sandbox Runtime (SRT) 接入层 — Windows 命令执行沙箱
//
// 设计：
// - 启动时 initSandbox() 检测 SRT 安装状态；装了就启用 SandboxManager。
// - wrapWithSandbox(command, args, cwd) 把命令包成 {argv, env} 返回；
//   null 表示 fallback 到直接 spawn（沙箱不可用 / wrap 失败）。
// - 沙箱不可用时 workspace_mutation 命令仍被拒绝（保持原行为）。
// - CYRENE_SRT=0 环境变量可强制禁用，出问题时 fallback。
//
// SRT API 要点（已 PoC 验证）：
// - namespace import（无 default export）：`await import('@anthropic-ai/sandbox-runtime')`
// - resolveSrtWin({ path: VENDORED_SRT_WIN_EXE }) → { exe, prependArgs: ['--srt-win'] }
// - checkWindowsSandboxStatusAsync({ srtWin }) → { user: { provisioned, sid }, wfp: { state } }
//   wfp.state='cannot-read' 是非管理员正常降级，沙箱仍可用
// - installWindowsSandboxAsync({ srtWin }) → { user, wfp, cancelled? }
//   cancelled:true 表示用户没点 UAC（不报错）
// - SandboxManager.initialize(config) 一次性初始化
// - SandboxManager.wrapWithSandboxArgv(cmdStr, binShell?, customConfig?, abortSignal?, cwd?, options?)
//   → { argv, env }，调用方自己 spawn({ shell: false })
// - command 参数是字符串（SRT 内部用 cmd.exe /c 跑，inner shell 在沙箱里所以安全）
// - allowWrite 目录必须先 mkdirSync 存在，否则 ACL grant 被丢弃

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { logger, LogTag } from "../../logger";
import { getCurrentLevel } from "../../permission";

// ── 模块级单例 ──────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SrtModule = any;

let srtModule: SrtModule | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let srtWin: any = null;
let sandboxReady = false;
let sandboxDisabled = false;
let initAttempted = false;

// ── 环境开关 ────────────────────────────────────────────

function isSrtDisabledByEnv(): boolean {
  return process.env.CYRENE_SRT === "0" || process.env.CYRENE_SRT === "false";
}

function isWindows(): boolean {
  return process.platform === "win32";
}

// ── 命令字符串拼接 ──────────────────────────────────────

/**
 * 把 executable + argv 拼成 SRT 接受的命令字符串。
 * 含空格的 token 用双引号包裹（cmd.exe 解析）。
 */
function buildCommandString(command: string, args: string[]): string {
  const quote = (s: string): string => {
    if (s === "") return '""';
    // 含空格或特殊字符 → 双引号包裹，内部双引号转义为 \"
    if (/[\s"<>|&^]/.test(s)) {
      return '"' + s.replace(/"/g, '\\"') + '"';
    }
    return s;
  };
  if (args.length === 0) return quote(command);
  return quote(command) + " " + args.map(quote).join(" ");
}

// ── 项目根检测 ──────────────────────────────────────────

/**
 * 从 cwd 向上查找项目根（.git / package.json / tsconfig.json）。
 * 找不到则回退到 cwd 本身。
 */
function detectProjectRoot(cwd: string): string {
  const start = path.resolve(cwd);
  let dir = start;
  for (let i = 0; i < 20; i++) {
    const hasGit = fs.existsSync(path.join(dir, ".git"));
    const hasPkg = fs.existsSync(path.join(dir, "package.json"));
    const hasTs = fs.existsSync(path.join(dir, "tsconfig.json"));
    if (hasGit || hasPkg || hasTs) {
      const markers = [hasGit && ".git", hasPkg && "package.json", hasTs && "tsconfig.json"].filter(Boolean).join(",");
      logger.info(LogTag.Runtime, `[Sandbox] detectProjectRoot: ${start} → ${dir} (found ${markers})`);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // 到达磁盘根
    dir = parent;
  }
  logger.info(LogTag.Runtime, `[Sandbox] detectProjectRoot: no project marker found from ${start}, fallback to cwd`);
  return path.resolve(cwd);
}

// ── 按档位构建 per-call filesystem 配置 ──────────────────

/**
 * 根据当前权限档位构建 per-call customConfig.filesystem。
 * - project-read-only: allowRead=[项目根], allowWrite=[]（只能读项目根，不能写）
 * - read-only: allowWrite=[]（读不限制，不能写）
 * - scoped: allowWrite=[cwd, homedir]（可在 cwd 和用户目录写）
 * - per-action: disabled=true（用户已审批，fs 不限制）
 * - full: 返回 null（不走沙箱，调用方直接 spawn）
 *
 * allowWrite 目录会先 mkdirSync 确保存在（ACL grant 依赖）。
 */
function buildFilesystemConfigForLevel(
  cwd: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { filesystem: any } | null {
  const level = getCurrentLevel();
  logger.info(LogTag.Runtime, `[Sandbox] buildFilesystemConfigForLevel: level=${level} cwd=${cwd}`);

  switch (level) {
    case "project-read-only": {
      const projectRoot = detectProjectRoot(cwd);
      logger.info(LogTag.Runtime, `[Sandbox] fs config [project-read-only]: allowRead=[${projectRoot}] allowWrite=[] denyRead=[] denyWrite=[]`);
      return {
        filesystem: {
          allowRead: [projectRoot],
          allowWrite: [],
          denyRead: [],
          denyWrite: [],
        },
      };
    }
    case "read-only":
      logger.info(LogTag.Runtime, `[Sandbox] fs config [read-only]: allowWrite=[] denyRead=[] denyWrite=[] (reads unrestricted)`);
      return {
        filesystem: {
          allowWrite: [],
          denyRead: [],
          denyWrite: [],
        },
      };
    case "scoped": {
      const homedir = os.homedir();
      const allowWriteDirs = [cwd, homedir];
      for (const d of allowWriteDirs) {
        try { fs.mkdirSync(d, { recursive: true }); } catch { /* 幂等 */ }
      }
      logger.info(LogTag.Runtime, `[Sandbox] fs config [scoped]: allowWrite=[${allowWriteDirs.join(", ")}] denyRead=[] denyWrite=[]`);
      return {
        filesystem: {
          allowWrite: allowWriteDirs,
          denyRead: [],
          denyWrite: [],
        },
      };
    }
    case "per-action":
      logger.info(LogTag.Runtime, `[Sandbox] fs config [per-action]: filesystem.disabled=true (user approved, fs unrestricted)`);
      return {
        filesystem: {
          disabled: true,
        },
      };
    case "full":
      logger.info(LogTag.Runtime, `[Sandbox] fs config [full]: null (no sandbox, direct spawn)`);
      return null;
  }
}

// ── SandboxManager 初始化 ──────────────────────────────

/**
 * 构建 SandboxManager.initialize 接受的 config。
 * allowWrite 目录必须先存在，否则 ACL grant 被丢弃。
 */
function buildSandboxConfig(allowWriteCwd: string): SrtModule["SandboxRuntimeConfig"] {
  // 确保 allowWrite 目录存在（ACL grant 依赖）
  try {
    fs.mkdirSync(allowWriteCwd, { recursive: true });
  } catch (err) {
    logger.warn(LogTag.Runtime, `[Sandbox] mkdir allowWrite failed: ${allowWriteCwd}`, err);
  }
  return {
    network: {
      allowedDomains: [],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: [],
      allowWrite: [allowWriteCwd],
      denyWrite: [],
    },
    windows: {
      srtWin: { path: srtModule.VENDORED_SRT_WIN_EXE },
    },
  };
}

/**
 * 初始化 SandboxManager（装好之后调用）。
 * 不做安装，不做状态检查 — 调用方确保已 provisioned。
 */
async function initSandboxManager(cwd: string): Promise<void> {
  if (!srtModule) throw new Error("SRT module not loaded");
  const config = buildSandboxConfig(cwd);
  logger.info(LogTag.Runtime, `[Sandbox] initSandboxManager: cwd=${cwd} allowWrite=${config.filesystem.allowWrite.join(",")} srtWin=${srtModule.VENDORED_SRT_WIN_EXE}`);
  await srtModule.SandboxManager.initialize(config);
  logger.info(LogTag.Runtime, "[Sandbox] SandboxManager.initialize completed");
}

// ── 公开 API ───────────────────────────────────────────

/**
 * 启动时检测 SRT 安装状态。
 * - 装了 → 初始化 SandboxManager → sandboxReady=true
 * - 没装 → 留 not-ready（不主动安装，避免启动时弹 UAC）
 * - 出错 → 标记 disabled，fallback 到直接 spawn
 *
 * 幂等：重复调用安全（initAttempted 守卫）。
 * 在 main/index.ts registerAllTools 前调用。
 */
export async function initSandbox(): Promise<void> {
  if (initAttempted) return;
  initAttempted = true;

  if (!isWindows()) {
    logger.info(LogTag.Runtime, "[Sandbox] non-Windows platform, skipping");
    return;
  }
  if (isSrtDisabledByEnv()) {
    logger.info(LogTag.Runtime, "[Sandbox] disabled by CYRENE_SRT env");
    sandboxDisabled = true;
    return;
  }

  try {
    // 无 default export，必须 namespace import
    srtModule = await import("@anthropic-ai/sandbox-runtime");
    srtWin = srtModule.resolveSrtWin({ path: srtModule.VENDORED_SRT_WIN_EXE });

    const status = await srtModule.checkWindowsSandboxStatusAsync({ srtWin });
    logger.info(LogTag.Runtime, `[Sandbox] status: user.provisioned=${status.user.provisioned} wfp.state=${status.wfp.state}`);

    if (!status.user.provisioned) {
      // 未安装：不主动装，留待首次 workspace_mutation 命令时 lazy install
      logger.info(LogTag.Runtime, "[Sandbox] not provisioned, will lazy-install on first workspace_mutation command");
      return;
    }
    // wfp.state='cannot-read' 是非管理员正常降级，沙箱仍可用
    // wfp.state='absent' 表示 WFP 没装；provisioned 但 absent 时也能跑（fs 沙箱生效，network 放行）
    // 这里只在 user 已 provisioned 时即认为可用

    await initSandboxManager(process.cwd());
    sandboxReady = true;
    logger.info(LogTag.Runtime, "[Sandbox] ready (sandboxed execution enabled)");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(LogTag.Runtime, `[Sandbox] init failed, disabling: ${msg}`);
    sandboxDisabled = true;
  }
}

/**
 * 沙箱是否已就绪（不触发 lazy install）。
 * executeRunShell 用这个判断 workspace_mutation 能否放行进沙箱。
 */
export function isSandboxReady(): boolean {
  return sandboxReady && !sandboxDisabled;
}

/**
 * 确保沙箱就绪：未就绪时尝试 lazy install（可能弹 UAC）。
 * - 已就绪 → true
 * - 未安装 → installWindowsSandboxAsync（UAC），用户取消则返回 false（不 disable）
 * - 其他错误 → disable 并返回 false
 *
 * UAC 取消不算错误（用户可能只是这次不想装），下次还会再试。
 */
async function ensureSandboxReady(): Promise<boolean> {
  if (sandboxDisabled || !isWindows()) {
    logger.info(LogTag.Runtime, `[Sandbox] ensureSandboxReady: skip (sandboxDisabled=${sandboxDisabled} isWindows=${isWindows()})`);
    return false;
  }
  if (sandboxReady) {
    logger.info(LogTag.Runtime, "[Sandbox] ensureSandboxReady: already ready");
    return true;
  }
  if (!srtModule || !srtWin) {
    logger.info(LogTag.Runtime, `[Sandbox] ensureSandboxReady: srtModule=${!!srtModule} srtWin=${!!srtWin}, cannot proceed`);
    return false;
  }

  try {
    logger.info(LogTag.Runtime, "[Sandbox] ensureSandboxReady: checking status...");
    const status = await srtModule.checkWindowsSandboxStatusAsync({ srtWin });
    logger.info(LogTag.Runtime, `[Sandbox] ensureSandboxReady: status user.provisioned=${status.user.provisioned} wfp.state=${status.wfp.state}`);
    if (!status.user.provisioned) {
      logger.info(LogTag.Runtime, "[Sandbox] not provisioned, attempting install (UAC may prompt)");
      const installResult = await srtModule.installWindowsSandboxAsync({ srtWin });
      if (installResult.cancelled) {
        logger.warn(LogTag.Runtime, "[Sandbox] install cancelled (UAC dismissed)");
        return false; // 不 disable，下次再试
      }
      logger.info(LogTag.Runtime, `[Sandbox] install completed: user.provisioned=${installResult.user?.provisioned} wfp.state=${installResult.wfp?.state}`);
    }
    await initSandboxManager(process.cwd());
    sandboxReady = true;
    logger.info(LogTag.Runtime, "[Sandbox] ready (lazy init)");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(LogTag.Runtime, `[Sandbox] lazy init failed, disabling: ${msg}`);
    sandboxDisabled = true;
    return false;
  }
}

/**
 * 把 command + args 包成沙箱 argv + env。
 *
 * @returns {argv, env} 调用方用 spawn(argv[0], argv.slice(1), {shell:false, env, cwd, stdio})；
 *          null 表示沙箱不可用或 wrap 失败，调用方 fallback 到直接 spawn。
 *
 * 流程：
 * 1. 沙箱未就绪 → 先 ensureSandboxReady()（可能弹 UAC，失败返回 null）
 * 2. 拼 command 字符串（含空格路径用双引号）
 * 3. 调 wrapWithSandboxArgv(cmdStr, undefined, customConfig, undefined, cwd)
 *    customConfig.filesystem.allowWrite=[cwd]（mkdir 后）保证命令能写自己的 cwd
 */
export async function wrapWithSandbox(
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv } | null> {
  const level = getCurrentLevel();
  logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: command=${command} args=${JSON.stringify(args)} cwd=${cwd || "(undefined)"} level=${level}`);

  if (sandboxDisabled || !isWindows()) {
    logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: skip (sandboxDisabled=${sandboxDisabled} isWindows=${isWindows()})`);
    return null;
  }

  // full 档位不走沙箱，直接返回 null 让调用方 spawn
  if (level === "full") {
    logger.info(LogTag.Runtime, "[Sandbox] wrapWithSandbox: full level, skipping sandbox (direct spawn)");
    return null;
  }

  const ready = await ensureSandboxReady();
  if (!ready || !srtModule) {
    logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: sandbox not ready (ready=${ready} srtModule=${!!srtModule}), returning null`);
    return null;
  }

  try {
    const cmdStr = buildCommandString(command, args);
    const resolvedCwd = cwd || process.cwd();
    logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: cmdStr="${cmdStr}" resolvedCwd=${resolvedCwd}`);

    // 确保 cwd 存在（ACL grant 依赖；mkdirSync recursive 是幂等的）
    try {
      fs.mkdirSync(resolvedCwd, { recursive: true });
    } catch (err) {
      // cwd 不存在 / 不可创建 → 让 SRT 自己处理；多数命令会在 spawn 时报错
      logger.warn(LogTag.Runtime, `[Sandbox] wrapWithSandbox: mkdir cwd failed: ${resolvedCwd}`, err);
    }

    // per-call customConfig：按当前权限档位选 fs 配置
    const customConfig = buildFilesystemConfigForLevel(resolvedCwd);
    if (!customConfig) {
      // full 档位（兜底，前面已拦截）
      logger.info(LogTag.Runtime, "[Sandbox] wrapWithSandbox: customConfig is null (full level fallback), returning null");
      return null;
    }

    logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: calling wrapWithSandboxArgv...`);
    const wrapped = await srtModule.SandboxManager.wrapWithSandboxArgv(
      cmdStr,
      undefined, // binShell：让 SRT 自己选（Windows 默认 cmd.exe）
      customConfig,
      undefined, // abortSignal
      resolvedCwd,
      undefined, // options
    );
    if (!wrapped || !Array.isArray(wrapped.argv) || wrapped.argv.length === 0) {
      logger.warn(LogTag.Runtime, `[Sandbox] wrapWithSandbox: wrap returned empty argv for: ${cmdStr} (wrapped=${JSON.stringify(wrapped)})`);
      return null;
    }
    logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: success, argv.length=${wrapped.argv.length} argv[0]=${wrapped.argv[0]}`);
    return { argv: wrapped.argv, env: wrapped.env };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(LogTag.Runtime, `[Sandbox] wrapWithSandbox: wrap failed, falling back: ${msg}`);
    return null;
  }
}

/**
 * 释放沙箱资源（进程退出前 SRT 自己会处理，这里仅兜底）。
 */
export async function resetSandbox(): Promise<void> {
  if (!srtModule || !sandboxReady) return;
  try {
    await srtModule.SandboxManager.reset();
  } catch {
    // 退出时忽略
  }
}
