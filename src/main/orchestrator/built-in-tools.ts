// 内置高危工具 — 给 agent 装上 fetch_url / run_shell / install_mcp_server 三件武器
// 全部走权限网关：fetch_url=network, run_shell=shell, install_mcp_server=fs-write
//
// 本文件正在按工具拆分到 builtin-tools/ 子目录（门禁：built-in-tools.snapshot.test.ts，
// 锁死注册插入顺序与模型可见字段）。每个工具模块在模块加载时自行 toolRegistry.register，
// 本文件保留为 facade：re-export 公共 API + 按原注册顺序 import 各工具模块，
// 所有既有 import 路径与运行时行为保持不变。

export { setUserTimezoneConfig, currentUserTimezone } from "./builtin-tools/timezone";
import { weatherTool } from "./builtin-tools/weather-tool";
export { setWeatherConfig, type WeatherCardData } from "./builtin-tools/weather-tool";

import { spawn } from "child_process";
import { toolRegistry } from "./tool-registry";
import { addMcpServer } from "./mcp-manager";
import { createPlayLive2DActionTool } from "./tools/play-live2d-action";
import { wrapWithSandbox, isSandboxReady } from "./sandbox/sandbox-exec";
import { getCurrentLevel } from "../permission";
import { classifyShellEffect, isCatastrophicCommand, type ShellEffect } from "./shell-execution-policy";

let sendToLive2DWindow: (channel: string, payload?: unknown) => void = () => {};
export function setLive2dWindowSender(sender: typeof sendToLive2DWindow): void {
  sendToLive2DWindow = sender;
}
import type { ToolContext } from "./tool-context";
import { VerificationRunner, resolveBuiltinExecutable } from "./verification-runner";
import { resolveWorkspaceBuildCommand } from "./workspace-build-command";
import { logger, LogTag } from "../logger";
import {
  buildDirectShellInvocation,
  resolveShellExecutable,
  type ShellKind,
} from "./shell-runtime";

const LOG_PREFIX = "[BuiltinTools]";

// ── 工具 1：fetch_url ─────────────────────────────────────
// 拉一个 URL 的纯文本 / Markdown 形式的 body，给 agent 读 README 用

const FETCH_TIMEOUT_MS = 20_000;
const FETCH_MAX_BYTES = 512 * 1024; // 单次最多 512KB，防止 LLM 上下文爆炸

// HTML → Markdown 清洗：用 turndown 转成 LLM 最易理解的 markdown 格式
// 保留标题层级/列表/代码块/表格/链接，比纯 strip 标签信息量大得多
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",        // <h1>→# <h2>→##
  codeBlockStyle: "fenced",   // <pre><code>→```围栏代码块（LLM 更认）
  bulletListMarker: "-",
  emDelimiter: "*",           // <em>→*斜体*
});

function stripHtml(html: string): string {
  // 先去 script/style/注释（turndown 不会自动去这些，留着会污染 markdown）
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // 转 markdown（保留结构），失败则退回纯 strip 标签
  try {
    const md = turndown.turndown(s);
    // 压缩多余空行（turndown 有时会留连续空行）
    return md.replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    // turndown 解析失败（畸形 HTML），退回原来的纯标签剥离
    s = s.replace(/<[^>]+>/g, " ");
    s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  }
}

async function executeFetchUrl(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const url = String(args.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return "[错误] url 必须以 http:// 或 https:// 开头";
  }
  const asMarkdown = args.format === "markdown" || args.format === undefined;
  console.log(LOG_PREFIX, "fetch_url:", url, "format=" + (asMarkdown ? "markdown" : "raw"));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  // 组合父 signal 和超时 signal
  const combinedSignal = ctx?.signal ? AbortSignal.any([ctx.signal, ac.signal]) : ac.signal;
  try {
    const resp = await fetch(url, {
      signal: combinedSignal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Cyrene Agent) Chrome/120 Safari/537.36",
        Accept: "text/html,text/markdown,text/plain,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!resp.ok) {
      return "[错误] HTTP " + resp.status + " " + resp.statusText;
    }
    const ctype = resp.headers.get("content-type") || "";
    const buf = await resp.arrayBuffer();
    const truncated = buf.byteLength > FETCH_MAX_BYTES;
    const slice = truncated ? buf.slice(0, FETCH_MAX_BYTES) : buf;
    let text = new TextDecoder("utf-8").decode(slice);
    if (asMarkdown && /text\/html|application\/xhtml/i.test(ctype)) {
      text = stripHtml(text);
    }
    const meta = "URL: " + url + "\nContent-Type: " + ctype + (truncated ? "\n[已截断到 " + FETCH_MAX_BYTES + " 字节]" : "") + "\n\n";
    return meta + text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] fetch 失败: " + msg;
  } finally {
    clearTimeout(timer);
  }
}

toolRegistry.register({
  id: "fetch_url",
  name: "读取网页",
  description:
    "下载指定 URL 的网页内容并返回正文。HTML 会用 turndown 转成结构化 markdown" +
    "（保留标题/列表/代码块/表格），便于阅读。\n\n" +
    "何时用：\n" +
    "- 用户给了明确的网址（https://...），想看内容\n" +
    "- 用户说'看看这个链接''读一下这个网页'\n" +
    "- 需要读 GitHub README、MCP 安装文档、API 文档等具体页面\n" +
    "- web_search 之后拿到链接，想看具体内容\n\n" +
    "不要用于：\n" +
    "- 用户只给关键词没给网址 → 用 web_search\n" +
    "- 用户问'今天有什么新闻' → 用 web_search\n" +
    "- 本地文件路径 → 用 read_file\n\n" +
    "参数：url (必填，完整 http(s) 地址)，format (可选 markdown|raw，默认 markdown)。",
  enabled: true,
  risk: "network",
  effectKind: "read" as const,
  verificationPolicy: "none" as const,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "要拉取的完整 URL（必须包含 https:// 或 http://）" },
      format: { type: "string", description: "markdown=自动清洗 HTML 为纯文本（默认）；raw=原文不处理" },
    },
    required: ["url"],
  },
  execute: executeFetchUrl,
});

// ── 工具 2：run_shell ─────────────────────────────────────
// 在用户机器上跑一行命令，给 agent 装 MCP 时跑 git/npm/pip 等用
// 注意：不开 shell（spawn shell:false），命令必须是真正的可执行文件，避免 shell 注入

// 双计时器：不看命令跑了多久，看它多久没动静。
// - idle：连续 2 分钟无任何 stdout/stderr → 判定卡死（serve/watch 类静默进程、网络死锁）。
//   npm install / git push / 打包这类"长但在动"的命令会持续输出，不会误杀。
// - total：30 分钟总上限，无论如何强制结束（兜底）。
const SHELL_IDLE_TIMEOUT_MS = 2 * 60_000;
const SHELL_TOTAL_TIMEOUT_MS = 30 * 60_000;
// killTree 后等 close 的宽限期。taskkill /T 在进程链断开时会漏杀孙进程，
// 孙进程持有的 stdio 管道不关 → close 永不触发 → Promise 永不 resolve（655 分钟挂死的根因）。
// 宽限期一到无条件强制收尸，带上已收集的部分输出。
const SHELL_KILL_GRACE_MS = 2_000;
const SHELL_MAX_OUTPUT = 16 * 1024;  // 单次最多 16KB stdout/stderr

// ── Shell 输出解码 ─────────────────────────────────────
// 中文 Windows 的 cmd.exe 按系统 OEM 码页（GBK/CP936）输出（dir/echo/del 等内建命令），
// 直接 chunk.toString("utf8") 中文全是 U+FFFD 乱码。策略：Buffer 原样累积，
// 进程结束时先严格 UTF-8 解码（node/npm/git 等现代工具输出 UTF-8），
// 含非法序列时回落 GBK 解码（Electron 自带 full-icu，TextDecoder("gbk") 可用）。
const utf8StrictDecoder = new TextDecoder("utf-8", { fatal: true });
let gbkDecoder: typeof utf8StrictDecoder | null = null;
try {
  gbkDecoder = new TextDecoder("gbk");
} catch {
  // 非 full-ICU 环境无 GBK：最终兜底宽松 UTF-8（替换字符）
}

function decodeShellOutput(chunks: Buffer[]): string {
  if (chunks.length === 0) return "";
  const buf = Buffer.concat(chunks).subarray(0, SHELL_MAX_OUTPUT);
  try {
    return utf8StrictDecoder.decode(buf);
  } catch {
    if (gbkDecoder) {
      try {
        return gbkDecoder.decode(buf);
      } catch {
        // GBK 也解不动（如二进制输出）：落到宽松 UTF-8
      }
    }
    return buf.toString("utf8");
  }
}

interface ShellResult {
  shell: ShellKind;
  shellExecutable?: string;
  errorCode?: "BASH_UNAVAILABLE";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  ranViaSandbox: boolean;
  /** 因 idle/total 超时或外部取消而被强制终止 */
  timedOut: boolean;
}

/** 可靠终止进程树。Windows 上 child.kill("SIGKILL") 只杀直接子进程，杀不掉孙进程。 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid == null) return;
  if (process.platform === "win32") {
    // /T=含整棵子树  /F=强制  砍掉进程树，避免孙进程成为孤儿
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
  } else {
    try { child.kill("SIGKILL"); } catch { /* 已退出则忽略 */ }
  }
}

/**
 * 执行一条完整 Shell 命令字符串。
 *
 * 默认用 `cmd.exe /d /s /c`；显式 shell=bash 时用探测到的 Git Bash 执行。
 * 两种模式都支持各自的管道、重定向和命令连接语义。
 *
 * @param command 完整命令行字符串（如 "git status | findstr TODO"）
 * @param useSandbox true 时优先走沙箱；沙箱不可用则 fallback 到直接 Shell（调用方判定是否接受）
 */
function runShellOnce(
  command: string,
  cwd?: string,
  extraEnv?: Record<string, string>,
  useSandbox?: boolean,
  requestedShell: ShellKind = "cmd",
  signal?: AbortSignal,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    (async () => {
      const resolvedShell = await resolveShellExecutable(requestedShell);
      if (!resolvedShell) {
        resolve({
          shell: requestedShell,
          errorCode: "BASH_UNAVAILABLE",
          exitCode: -1,
          stdout: "",
          stderr: "[BASH_UNAVAILABLE] 未找到可用的 Bash。请安装 Git Bash，并确保 bash.exe 可执行。",
          truncated: false,
          ranViaSandbox: false,
          timedOut: false,
        });
        return;
      }

      const directInvocation = buildDirectShellInvocation(resolvedShell, command);
      let spawnCmd: string = directInvocation.command;
      let spawnArgs: string[] = directInvocation.args;
      let spawnEnv: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
      let ranViaSandbox = false;

      if (useSandbox) {
        try {
          const wrapped = await wrapWithSandbox(
            command,
            cwd,
            requestedShell === "bash" ? resolvedShell.executable : undefined,
          );
          if (wrapped) {
            spawnCmd = wrapped.argv[0];
            spawnArgs = wrapped.argv.slice(1);
            // 沙箱 env 是 SRT 给的（含必要的 PATH/token 等），extraEnv 叠加在后面
            spawnEnv = { ...wrapped.env, ...extraEnv };
            ranViaSandbox = true;
          } else {
            // wrap 返回 null（沙箱不可用/失败）→ fallback 到直接 Shell
            // 调用方需自行判断是否接受 fallback（写副作用命令不接受 fallback）
            console.log(LOG_PREFIX, `run_shell sandbox unavailable, fallback to direct ${requestedShell}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(LOG_PREFIX, "run_shell wrap exception, fallback:", msg);
        }
      }

      const child = spawn(spawnCmd, spawnArgs, {
        cwd: cwd || undefined,
        shell: false,
        windowsHide: true,
        env: spawnEnv,
        // 直接 cmd.exe 路径必须 verbatim：Node 默认对 argv 做 MSVCRT 转义（" → \"），
        // 而 cmd.exe 的 /s 规则只剥首尾引号、不认 \" 转义，字面引号会传给目标程序——
        // 带引号路径如 node "E:\video test\_check.js" 会变成非法模块名。
        // windowsVerbatimArguments 让 argv 原样空格拼接，引号语义完全交给 cmd。
        // 沙箱路径不加：srt-win 是 Rust 程序（MSVCRT 解析 argv），与 Node 自动转义配对正确。
        ...(ranViaSandbox || !directInvocation.windowsVerbatimArguments ? {} : { windowsVerbatimArguments: true }),
        // stdin→/dev/null(NUL)：误启动交互式进程(python/node REPL)时让它读到 EOF 立即退出，
        // 不再卡在"等 stdin 输入"上耗满超时。stdout/stderr 仍 pipe 来收集输出。
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Buffer 原样累积（16KB 上限），进程结束时按 UTF-8→GBK 顺序解码（见 decodeShellOutput）
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;

      // ── 双计时器 + 强制收尸 ──────────────────────────────
      // settled 保证只 resolve 一次；close/error/强制收尸任何一方先到都安全。
      let settled = false;
      let idleTimer: NodeJS.Timeout | undefined;
      let totalTimer: NodeJS.Timeout | undefined;
      let killGraceTimer: NodeJS.Timeout | undefined;
      const clearTimers = () => {
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        clearTimeout(killGraceTimer);
      };
      const finish = (result: ShellResult) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      type StuckReason = "idle" | "total" | "cancelled";
      const reasonText: Record<StuckReason, string> = {
        idle: `命令连续 ${SHELL_IDLE_TIMEOUT_MS / 60_000} 分钟无任何输出（疑似常驻进程或卡死）`,
        total: `命令超过 ${SHELL_TOTAL_TIMEOUT_MS / 60_000} 分钟总上限`,
        cancelled: "所在任务已被用户取消",
      };
      const onStuck = (reason: StuckReason) => {
        console.warn(LOG_PREFIX, `run_shell 终止(${reason})，kill 进程树:`, command);
        killTree(child);
        // 宽限期后强制收尸：close 事件要求 stdio 管道全关，taskkill 漏杀孙进程时
        // 管道保持打开、close 永不触发。宽限期内 close 正常到达则 finish 已短路。
        killGraceTimer = setTimeout(() => {
          finish({
            shell: requestedShell,
            shellExecutable: resolvedShell.executable,
            exitCode: null,
            stdout: decodeShellOutput(stdoutChunks),
            stderr: decodeShellOutput(stderrChunks)
              + `\n[已终止] ${reasonText[reason]}，进程树已被强制终止。`,
            truncated,
            ranViaSandbox,
            timedOut: true,
          });
        }, SHELL_KILL_GRACE_MS);
      };
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => onStuck("idle"), SHELL_IDLE_TIMEOUT_MS);
      };
      const onAbort = () => onStuck("cancelled");

      totalTimer = setTimeout(() => onStuck("total"), SHELL_TOTAL_TIMEOUT_MS);
      resetIdle();
      if (signal) {
        if (signal.aborted) onStuck("cancelled");
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        resetIdle();
        if (stdoutBytes >= SHELL_MAX_OUTPUT) {
          truncated = true;
          return;
        }
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
        if (stdoutBytes > SHELL_MAX_OUTPUT) truncated = true;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        resetIdle();
        if (stderrBytes >= SHELL_MAX_OUTPUT) {
          truncated = true;
          return;
        }
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
        if (stderrBytes > SHELL_MAX_OUTPUT) truncated = true;
      });
      child.on("error", (err) => {
        finish({
          shell: requestedShell,
          shellExecutable: resolvedShell.executable,
          exitCode: -1,
          stdout: decodeShellOutput(stdoutChunks),
          stderr: decodeShellOutput(stderrChunks) + "\n[spawn error] " + err.message + (ranViaSandbox ? " [sandbox]" : ""),
          truncated,
          ranViaSandbox,
          timedOut: false,
        });
      });
      child.on("close", (code) => {
        finish({
          shell: requestedShell,
          shellExecutable: resolvedShell.executable,
          exitCode: code,
          stdout: decodeShellOutput(stdoutChunks),
          stderr: decodeShellOutput(stderrChunks),
          truncated,
          ranViaSandbox,
          timedOut: false,
        });
      });
    })().catch((err) => {
      // async wrapper 异常兜底（理论上不会走到，wrapWithSandbox 内部已 try/catch）
      const msg = err instanceof Error ? err.message : String(err);
      resolve({
        shell: requestedShell,
        exitCode: -1,
        stdout: "",
        stderr: "[runShellOnce internal error] " + msg,
        truncated: false,
        ranViaSandbox: false,
        timedOut: false,
      });
    });
  });
}

async function executeRunShell(args: Record<string, unknown>, context?: import("./tool-context").ToolContext): Promise<string> {
  const command = String(args.command || "").trim();
  const cwd = args.cwd ? String(args.cwd) : undefined;
  const requestedShell = args.shell === undefined || args.shell === "cmd"
    ? "cmd"
    : args.shell === "bash"
      ? "bash"
      : null;
  if (!command) return "[错误] command 不能为空";
  if (!requestedShell) {
    return JSON.stringify({
      command, cwd, shell: String(args.shell), errorCode: "SHELL_UNSUPPORTED",
      exitCode: -1, stdout: "", stderr: "[SHELL_UNSUPPORTED] shell 仅支持 cmd 或 bash",
      timedOut: false, truncated: false, effect: "unknown", sandboxed: false,
    });
  }

  // 灾难命令守卫：无论档位都拒绝（format/shutdown/dd 等明显灾难操作）
  if (isCatastrophicCommand(command)) {
    logger.info(LogTag.BuiltinTools, `[run_shell] rejected: catastrophic command="${command}"`);
    return JSON.stringify({
      command, cwd, shell: requestedShell,
      exitCode: -1, stdout: "", stderr: "[拒绝] 该命令被系统禁止执行",
      timedOut: false, truncated: false, effect: "unknown", sandboxed: false,
    });
  }

  const level = context?.permissionMode === "allow_all" ? "full" : getCurrentLevel();
  const effect: ShellEffect = classifyShellEffect(command);
  logger.info(LogTag.BuiltinTools, `[run_shell] entry: command="${command}" cwd=${cwd || "(undefined)"} effect=${effect} level=${level}`);

  // full 档位：直接 spawn，不走沙箱（用户已选择完全信任）
  if (level === "full") {
    logger.info(LogTag.BuiltinTools, `[run_shell] full level → direct ${requestedShell} (no sandbox)`);
    const result = await runShellOnce(command, cwd, undefined, false, requestedShell, context?.signal);
    logger.info(LogTag.BuiltinTools, `[run_shell] [full] done: exitCode=${result.exitCode} timedOut=${result.timedOut} stdout.len=${result.stdout.length} stderr.len=${result.stderr.length}`);
    return JSON.stringify({
      command, cwd, shell: result.shell, shellExecutable: result.shellExecutable, errorCode: result.errorCode,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      truncated: result.truncated,
      effect,
      sandboxed: false,
    });
  }

  // 非 full 档位：按副作用路由
  // - read  → 沙箱优先，不可用则允许 fallback 到直接 cmd.exe（graceful degradation）
  // - write/unknown → 必须沙箱，沙箱不可用或 wrap 失败则拒绝（不 fallback）
  const requiresSandbox = effect !== "read";

  if (requiresSandbox && !isSandboxReady()) {
    logger.info(LogTag.BuiltinTools, `[run_shell] write/unknown → sandbox not ready (level=${level}), rejected`);
    return JSON.stringify({
      command, cwd, shell: requestedShell,
      exitCode: -1, stdout: "",
      stderr: "[拒绝] 沙箱不可用，该命令可能修改工作区，已终止。请在设置中安装沙箱或提升权限档位。",
      timedOut: false, truncated: false, effect, sandboxed: false,
    });
  }

  const useSandbox = isSandboxReady();
  logger.info(LogTag.BuiltinTools, `[run_shell] ${level} → useSandbox=${useSandbox} effect=${effect}`);
  const result = await runShellOnce(command, cwd, undefined, useSandbox, requestedShell, context?.signal);

  // 写副作用命令若 fallback 到直接 spawn（沙箱 wrap 失败）→ 拒绝
  if (requiresSandbox && useSandbox && !result.ranViaSandbox) {
    logger.warn(LogTag.BuiltinTools, `[run_shell] write/unknown → sandbox wrap failed (fell back to direct spawn), rejected. stderr=${result.stderr.slice(0, 200)}`);
    return JSON.stringify({
      command, cwd, shell: result.shell, shellExecutable: result.shellExecutable, errorCode: result.errorCode,
      exitCode: -1, stdout: result.stdout,
      stderr: result.stderr + "\n[拒绝] 沙箱不可用，该命令可能修改工作区，已终止",
      timedOut: result.timedOut, truncated: result.truncated, effect, sandboxed: false,
    });
  }

  logger.info(LogTag.BuiltinTools, `[run_shell] [${level}] done: exitCode=${result.exitCode} timedOut=${result.timedOut} stdout.len=${result.stdout.length} stderr.len=${result.stderr.length} sandboxed=${result.ranViaSandbox}`);
  return JSON.stringify({
    command, cwd, shell: result.shell, shellExecutable: result.shellExecutable, errorCode: result.errorCode,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    truncated: result.truncated,
    effect,
    sandboxed: result.ranViaSandbox,
  });
}

toolRegistry.register({
  id: "run_shell",
  name: "执行命令",
  description:
    "在用户电脑上执行一条 Shell 命令字符串。默认由 cmd.exe 解析；需要类 Unix 语法时可显式选择 bash。返回 exitCode + stdout + stderr。\n\n" +
    "cmd 模式语义：\n" +
    "- 管道：git status | findstr TODO\n" +
    "- 重定向：npm run build > build.log 或 echo hello >> out.txt\n" +
    "- 命令串联：cd src && dir 或 git add . && git commit -m msg\n" +
    "- cmd 内建命令：dir / type / echo / del / copy / set 等可直接用\n" +
    "- 环境变量：%VAR% 会被展开\n\n" +
    "bash 模式语义：\n" +
    "- 设置 shell=\"bash\"，可使用 pwd / grep / sed / awk、$VAR、POSIX 管道及脚本语法\n" +
    "- 仅在检测到可用 Git Bash 时执行；不可用会明确返回 BASH_UNAVAILABLE，不会改用 cmd\n\n" +
    "何时用：\n" +
    "- git clone / git status / git log 等版本控制操作\n" +
    "- npm install / npm run / pip install / node xxx.js 等开发操作\n" +
    "- node --version / python --version 等查环境\n" +
    "- 用户明确要求'跑一下这条命令'\n" +
    "- 需要管道/重定向组合的命令\n\n" +
    "不要用于：\n" +
    "- 读文件 → read_file（更安全）\n" +
    "- 列目录 → list_dir\n" +
    "- 搜索代码内容 → search_text\n" +
    "- 下载网页 → fetch_url\n" +
    "- 启动常驻进程（dev server / npx serve / watch / tail -f）→ 本工具只适合跑完就退出的命令，" +
    "常驻进程会在 2 分钟无输出后被强制终止；需要预览服务时，构建完成后告知用户自行启动\n" +
    "- 能用专用工具完成的事\n\n" +
    "安全说明：非完全信任档位下，写副作用的命令会在沙箱中执行（限制文件系统访问范围）。" +
    "灾难命令（format/shutdown/dd 等）一律拒绝。\n" +
    "参数：command (完整命令行字符串，如 \"git status\")，cwd (可选工作目录)，shell (cmd 或 bash，默认 cmd)。",
  enabled: true,
  risk: "shell",
  modes: ["code", "work"],
  effectKind: "unknown" as const,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "完整命令行字符串，如 \"git status\"、\"npm install\"、\"dir | findstr TODO\"" },
      cwd: { type: "string", description: "工作目录绝对路径，可选" },
      shell: {
        type: "string",
        enum: ["cmd", "bash"],
        default: "cmd",
        description: "命令解释器：cmd（默认，兼容旧命令）或 bash（需要用户已安装 Git Bash）",
      },
    },
    required: ["command"],
  },
  execute: executeRunShell,
});

// ── 工具：run_verification（受限验证工具）─────────────────────
// 唯一能产生可信 verification evidence 的工具。
// 只执行预定义的验证命令（typecheck/test/build/lint），不接受任意命令。
// ledgerPolicy=bypass：不缓存验证结果（相同参数在新 revision 下必须重新执行）。
toolRegistry.register({
  id: "run_verification",
  name: "运行验证",
  description:
    "执行代码验证（类型检查/测试/构建/lint）。是唯一能产生可信验证证据的工具。\n\n" +
    "何时用：\n" +
    "- 代码修改后需要验证编译是否通过\n" +
    "- 需要运行测试确认修改正确\n" +
    "- 需要 lint 检查代码风格\n\n" +
    "不要用于：\n" +
    "- 读取文件内容 → read_file\n" +
    "- 执行任意命令 → run_shell\n" +
    "- 修改代码 → apply_patch/str_replace/write_file\n\n" +
    "参数：verificationType（验证类型：typecheck/test/build/lint），cwd（可选工作目录）。",
  enabled: true,
  risk: "shell",
  modes: ["code", "work"],
  effectKind: "verification" as const,
  ledgerPolicy: "bypass" as const,
  inputSchema: {
    type: "object",
    properties: {
      verificationType: {
        type: "string",
        enum: ["typecheck", "test", "build", "lint"],
        description: "验证类型：typecheck=类型检查，test=运行测试，build=构建，lint=代码风格检查",
      },
      cwd: { type: "string", description: "工作目录绝对路径，可选" },
    },
    required: ["verificationType"],
  },
  execute: async (args) => {
    const verificationType = String(args.verificationType || "").trim();
    const cwd = args.cwd ? String(args.cwd) : undefined;

    if (!verificationType) return JSON.stringify({
      success: false, errorCode: "INVALID_INPUT", error: "verificationType 不能为空",
      verificationType: "", command: "", exitCode: -1,
      stdout: "", stderr: "[错误] verificationType 不能为空",
      timedOut: false, passed: false, truncated: false, durationMs: 0, retryable: false,
    });

    // 根据验证类型选择命令（白名单，不接受任意命令）
    const fs = require("fs");
    const path = require("path");

    type WorkVerificationCommand = {
      cmd: string;
      args: string[];
      trust: "builtin" | "workspace_script";
      source: "tsconfig" | "vitest" | "package_script";
      configPath?: string;
    };
    let verificationCommands: Record<string, WorkVerificationCommand>;
    const actualCwd = cwd || process.cwd();

    if (verificationType === "typecheck") {
      // 1. 确定 tsconfig 路径
      let tsconfigPath: string;
      if (cwd) {
        const hasMain = fs.existsSync(path.join(cwd, "tsconfig.main.json"));
        const hasDefault = fs.existsSync(path.join(cwd, "tsconfig.json"));
        if (hasMain) {
          tsconfigPath = path.join(cwd, "tsconfig.main.json");
        } else if (hasDefault) {
          tsconfigPath = path.join(cwd, "tsconfig.json");
        } else {
          return JSON.stringify({
            success: false, errorCode: "VERIFICATION_CONFIG_NOT_FOUND",
            error: `cwd 下未找到 tsconfig.main.json 或 tsconfig.json: ${cwd}`,
            verificationType, command: "", exitCode: -1,
            stdout: "", stderr: `[错误] 未找到 TypeScript 配置文件: ${cwd}`,
            timedOut: false, passed: false, truncated: false, durationMs: 0, retryable: false,
            actualCwd: cwd,
          });
        }
      } else {
        tsconfigPath = "tsconfig.main.json";
      }

      // 2. 复用 VerificationRunner 的本地 CLI 解析（禁止 npx / 全局 PATH）
      if (!resolveBuiltinExecutable("builtin:tsc", actualCwd, tsconfigPath)) {
        return JSON.stringify({
          success: false, errorCode: "TYPESCRIPT_NOT_FOUND",
          error: `本地 TypeScript 未安装: ${actualCwd}`,
          verificationType, command: "", exitCode: -1,
          stdout: "", stderr: `[TYPESCRIPT_NOT_FOUND] local typescript CLI not found in ${actualCwd}`,
          timedOut: false, passed: false, truncated: false, durationMs: 0, retryable: false,
          actualCwd: cwd,
        });
      }

      verificationCommands = {
        typecheck: {
          cmd: "builtin:tsc",
          args: ["-p", tsconfigPath, "--noEmit"],
          trust: "builtin",
          source: "tsconfig",
          configPath: tsconfigPath,
        },
      };
    } else if (verificationType === "build") {
      const buildCommand = await resolveWorkspaceBuildCommand(actualCwd);
      if (!buildCommand.ok) {
        return JSON.stringify({
          success: false,
          errorCode: buildCommand.errorCode,
          error: buildCommand.error,
          verificationType,
          command: "",
          exitCode: -1,
          stdout: "",
          stderr: `[${buildCommand.errorCode}] ${buildCommand.error}`,
          timedOut: false,
          passed: false,
          truncated: false,
          durationMs: 0,
          retryable: false,
          actualCwd,
        });
      }
      verificationCommands = {
        build: {
          cmd: buildCommand.command,
          args: buildCommand.args,
          trust: "workspace_script",
          source: "package_script",
        },
      };
    } else {
      verificationCommands = {
        test: {
          cmd: "builtin:vitest",
          args: ["--reporter=verbose"],
          trust: "builtin",
          source: "vitest",
        },
        lint: {
          cmd: process.execPath,
          args: [],
          trust: "workspace_script",
          source: "package_script",
        },
      };
    }

    const command = verificationCommands[verificationType];
    if (!command) return JSON.stringify({
      success: false, errorCode: "INVALID_INPUT",
      error: `不支持的验证类型: ${verificationType}，支持: typecheck/test/build/lint`,
      verificationType, command: "", exitCode: -1,
      stdout: "", stderr: `[错误] 不支持的验证类型: ${verificationType}`,
      timedOut: false, passed: false, truncated: false, durationMs: 0, retryable: false,
    });

    if (verificationType === "test" && !resolveBuiltinExecutable("builtin:vitest", actualCwd)) {
      return JSON.stringify({
        success: false, errorCode: "VITEST_NOT_FOUND",
        error: `本地 Vitest 未安装: ${actualCwd}`,
        verificationType, command: "", exitCode: -1,
        stdout: "", stderr: `[VITEST_NOT_FOUND] local vitest CLI not found in ${actualCwd}`,
        timedOut: false, passed: false, truncated: false, durationMs: 0, retryable: false,
        actualCwd,
      });
    }
    if (verificationType === "lint") {
      try {
        const eslintPath = require.resolve("eslint/bin/eslint.js", { paths: [actualCwd] });
        if (!fs.existsSync(eslintPath) || !path.isAbsolute(eslintPath)) throw new Error("invalid eslint path");
        command.args = [eslintPath, "src/main", "--max-warnings=0"];
      } catch {
        return JSON.stringify({
          success: false, errorCode: "ESLINT_NOT_FOUND",
          error: `本地 ESLint 未安装: ${actualCwd}`,
          verificationType, command: "", exitCode: -1,
          stdout: "", stderr: `[ESLINT_NOT_FOUND] local eslint CLI not found in ${actualCwd}`,
          timedOut: false, passed: false, truncated: false, durationMs: 0, retryable: false,
          actualCwd,
        });
      }
    }

    const resolvedForDisplay = resolveBuiltinExecutable(command.cmd, actualCwd, command.configPath);
    const displayExecutable = resolvedForDisplay?.executable ?? command.cmd;
    const displayArgs = [...(resolvedForDisplay?.args ?? []), ...command.args];
    const startMs = Date.now();
    const actualCommand = `${displayExecutable} ${displayArgs.join(" ")}`;
    console.log(LOG_PREFIX, "run_verification:", verificationType, actualCommand, cwd ? "cwd=" + cwd : "");

    // 复用 Code 模式的 VerificationRunner（同一个执行核心）
    // 旧协议 JSON 输出格式保持不变
    const runner = new VerificationRunner();
    try {
      const result = await runner.runStep({
        id: `run_verification_${verificationType}`,
        type: verificationType as any,
        packageRoot: cwd || process.cwd(),
        cwd: cwd || process.cwd(),
        configPath: command.configPath,
        trust: command.trust,
        executable: command.cmd,
        args: command.args,
        source: command.source,
      }, {
        // 仅在工具真实执行时读取宿主档位；模块加载阶段保持 VerificationRunner 纯净。
        permissionLevel: (await import("../permission")).getCurrentLevel(),
        signal: undefined,
      });

      const durationMs = Date.now() - startMs;
      const passed = result.passed;
      console.log(LOG_PREFIX, "run_verification 完成:", verificationType,
        "exitCode=" + result.exitCode, "passed=" + passed, "durationMs=" + durationMs,
        "stdoutLen=" + result.stdout.length, "stderrLen=" + result.stderr.length);

      // 兼容旧协议 JSON：errorCode 来自 result.errorCode
      const errorCode = result.errorCode;
      const isApprovalRequired = errorCode === "VERIFICATION_APPROVAL_REQUIRED";
      const isTimeout = errorCode === "VERIFICATION_TIMEOUT" || result.timedOut;

      return JSON.stringify({
        // 旧协议中 success 表示“命令已被 Runner 正常接管”，退出码由 passed 表示。
        success: !isApprovalRequired && !isTimeout,
        verificationType,
        command: actualCommand,
        actualCwd: cwd || process.cwd(),
        exitCode: result.exitCode ?? -1,
        stdout: result.stdout,
        stderr: result.stderr,
        spawnError: null,
        timedOut: result.timedOut,
        passed,
        truncated: result.stdout.includes("... (truncated") || result.stderr.includes("... (truncated"),
        durationMs,
        errorCode,
        retryable: isTimeout,
        ...(isApprovalRequired ? { approvalRequired: true } : {}),
      });
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(LOG_PREFIX, "run_verification 失败:", verificationType, "error:", msg);
      return JSON.stringify({
        success: false,
        errorCode: "VERIFICATION_SPAWN_FAILED",
        error: `命令启动失败: ${msg}`,
        verificationType,
        command: actualCommand,
        actualCwd: cwd || process.cwd(),
        exitCode: -1,
        stdout: "",
        stderr: `[VERIFICATION_SPAWN_FAILED] ${msg}`,
        spawnError: { code: undefined, message: msg },
        timedOut: false,
        passed: false,
        truncated: false,
        durationMs,
        retryable: false,
      });
    }
  },
});

// ── 工具 3：install_mcp_server ────────────────────────────
// 把一个 {command, args, env} 注册成新的 MCP server。
// agent 读完 README 的 mcpServers 配置后，调这个工具一次性写盘 + 启动 + 发现工具

async function executeInstallMcp(args: Record<string, unknown>): Promise<string> {
  const id = (String(args.id || "").trim()) || ("mcp-" + Date.now());
  const name = String(args.name || "").trim() || id;
  const command = String(args.command || "").trim();
  if (!command) return "[错误] command 不能为空";

  const cmdArgs = Array.isArray(args.args) ? (args.args as unknown[]).map((x) => String(x)) : [];
  let env: Record<string, string> | undefined;
  if (args.env && typeof args.env === "object") {
    env = {};
    for (const [k, v] of Object.entries(args.env as Record<string, unknown>)) {
      env[k] = String(v);
    }
  }
  const cwd = args.cwd ? String(args.cwd) : undefined;

  console.log(LOG_PREFIX, "install_mcp_server:", id, name, command, JSON.stringify(cmdArgs).slice(0, 200));
  if (env) console.log(LOG_PREFIX, "  env keys:", Object.keys(env).join(","));
  if (cwd) console.log(LOG_PREFIX, "  cwd:", cwd);

  try {
    const result = await addMcpServer({
      id,
      name,
      transport: "stdio",
      command,
      args: cmdArgs,
      env,
      cwd,
    });
    if (!result.ok) {
      return "[错误] 安装失败: " + (result.error || "未知错误");
    }
    const tools = result.toolIds || [];
    return (
      "✅ MCP server \"" + name + "\" 已连接\n" +
      "id: " + id + "\n" +
      "command: " + command + (cmdArgs.length ? " " + cmdArgs.join(" ") : "") + "\n" +
      "发现 " + tools.length + " 个工具" + (tools.length ? "：\n  - " + tools.join("\n  - ") : "") + "\n" +
      "你现在可以让我用这些工具帮你做事。"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] 安装异常: " + msg;
  }
}

toolRegistry.register({
  id: "install_mcp_server",
  name: "安装 MCP",
  description:
    "把一个 MCP server 加到昔涟的工具盘里：写入配置 → 启动 → 发现工具。\n\n" +
    "何时用：\n" +
    "- 用户明确要装某个 MCP server（'帮我装 xxx mcp'）\n" +
    "- 用户给了 MCP 的 GitHub 仓库或配置\n\n" +
    "推荐流程：先用 fetch_url 读 README，找到 mcpServers 配置块" +
    "（command/args/env），再用本工具一次性安装。\n\n" +
    "不要用于：\n" +
    "- 日常工具调用（已注册的工具直接用）\n" +
    "- 系统软件安装（那是 run_shell 的活）\n\n" +
    "参数：id (可选，唯一标识，留空则用时间戳)，name (展示名)，command (可执行命令)，" +
    "args (字符串数组)，env (键值对，环境变量)，cwd (可选工作目录)。",
  enabled: true,
  risk: "fs-write",
  modes: ["code", "work"],
  effectKind: "mutation" as const,
  verificationPolicy: "artifact" as const,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "唯一标识，留空则自动生成" },
      name: { type: "string", description: "展示名，比如 'mail-mcp'" },
      command: { type: "string", description: "可执行命令，例如 'node' / 'pythonw' / 'npx'" },
      args: { type: "array", description: "命令行参数数组，例如 ['C:/.../bridging_mail_mcp.py']" },
      env: { type: "object", description: "环境变量键值对" },
      cwd: { type: "string", description: "工作目录绝对路径，可选" },
    },
    required: ["command"],
  },
  execute: executeInstallMcp,
});

logger.info(LogTag.BuiltinTools, "registered: fetch_url / run_shell / install_mcp_server");

toolRegistry.register(weatherTool);

// ── 工具 5：web_search（博查搜索）─────────────────────────
// 联网搜索：给关键词，返回搜索结果（标题/链接/摘要）。博查 API 返回 AI 友好的结构化数据。
// key 通过 setSearchConfig 注入（避免 import index.ts 造成循环依赖）。

const SEARCH_TIMEOUT_MS = 20_000;

/** 注入的搜索配置获取器。 */
let searchEngineGetter: (() => string) | null = null;
let searchBochaKeyGetter: (() => string) | null = null;
let searchTavilyKeyGetter: (() => string) | null = null;
let searchAnySearchKeyGetter: (() => string) | null = null;

/**
 * index.ts 启动时调用，注入搜索引擎/各源key 的读取器。
 * engine: "off" | "bocha" | "tavily" | "volcano" | "minimax"
 */
export function setSearchConfig(
  engineGetter: () => string,
  bochaKeyGetter: () => string,
  tavilyKeyGetter: () => string,
  anySearchKeyGetter: () => string,
): void {
  searchEngineGetter = engineGetter;
  searchBochaKeyGetter = bochaKeyGetter;
  searchTavilyKeyGetter = tavilyKeyGetter;
  searchAnySearchKeyGetter = anySearchKeyGetter;
}

interface BochaResult {
  name: string;
  url: string;
  snippet: string;
  summary?: string;
  siteName?: string;
}

/** 搜索结果统一结构 */
interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

/** 搜索输出统一结构（ToolCallResult.output 的 JSON） */
interface WebSearchOutput {
  success: true;
  query: string;
  resultCount: number;
  results: WebSearchResult[];
}

/** snippet 最大长度 */
const MAX_SNIPPET_LEN = 500;

/** 截断 snippet */
function truncateSnippet(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_SNIPPET_LEN ? clean.slice(0, MAX_SNIPPET_LEN) + "..." : clean;
}

/** 博查搜索：调 /v1/web-search，返回结构化 JSON。 */
async function bochaSearch(query: string, key: string, signal?: AbortSignal): Promise<string> {
  const url = "https://api.bochaai.com/v1/web-search";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  // 组合父 signal 和超时 signal
  const combinedSignal = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: combinedSignal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        count: 8,
        summary: true,
      }),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const raw = await resp.json() as {
      webPages?: { value?: BochaResult[] };
      data?: { webPages?: { value?: BochaResult[] } };
    };
    const bochaResults = raw.data?.webPages?.value ?? raw.webPages?.value ?? [];
    const results: WebSearchResult[] = bochaResults.map((r) => ({
      title: r.name,
      url: r.url,
      snippet: truncateSnippet(r.summary || r.snippet || ""),
      ...(r.siteName ? { source: r.siteName } : {}),
    }));
    const output: WebSearchOutput = {
      success: true,
      query,
      resultCount: results.length,
      results,
    };
    return JSON.stringify(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`搜索失败：${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Tavily 搜索：调 /search，返回结构化 JSON。 */
async function tavilySearch(query: string, key: string, signal?: AbortSignal): Promise<string> {
  const url = "https://api.tavily.com/search";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  // 组合父 signal 和超时 signal
  const combinedSignal = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: combinedSignal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: 8,
        include_answer: true,
      }),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json() as {
      answer?: string;
      results?: Array<{ title: string; url: string; content: string }>;
    };
    const tavilyResults = data.results ?? [];
    const results: WebSearchResult[] = tavilyResults.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: truncateSnippet(data.answer && r.content ? `${data.answer}\n${r.content}` : r.content || ""),
    }));
    const output: WebSearchOutput = {
      success: true,
      query,
      resultCount: results.length,
      results,
    };
    return JSON.stringify(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`搜索失败：${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/** AnySearch 搜索：调 /v1/search，返回结构化 JSON。 */
async function anySearchSearch(query: string, key: string, signal?: AbortSignal): Promise<string> {
  const url = "https://api.anysearch.com/v1/search";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  // 组合父 signal 和超时 signal
  const combinedSignal = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: combinedSignal,
      headers,
      body: JSON.stringify({
        query,
        max_results: 8,
      }),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json() as {
      data: { results?: Array<{ title: string; url: string; content: string; snippet: string }> };
    };
    const rawResults = data.data.results ?? [];
    const results: WebSearchResult[] = rawResults.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: truncateSnippet(r.content || r.snippet || ""),
    }));
    const output: WebSearchOutput = {
      success: true,
      query,
      resultCount: results.length,
      results,
    };
    return JSON.stringify(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`搜索失败：${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

async function executeWebSearch(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const engine = searchEngineGetter?.() ?? "off";
  if (engine === "off") {
    throw new Error("E_SEARCH_NOT_ENABLED");
  }

  const query = String(args.query ?? "").trim();
  if (!query) {
    throw new Error("E_SEARCH_QUERY_EMPTY");
  }

  if (engine === "bocha") {
    const key = searchBochaKeyGetter?.() ?? "";
    if (!key) {
      throw new Error("E_SEARCH_KEY_MISSING");
    }
    return bochaSearch(query, key, ctx?.signal);
  }

  if (engine === "tavily") {
    const key = searchTavilyKeyGetter?.() ?? "";
    if (!key) {
      throw new Error("E_SEARCH_KEY_MISSING");
    }
    return tavilySearch(query, key, ctx?.signal);
  }

  if (engine === "anySearch") {
    const key = searchAnySearchKeyGetter?.() ?? "";
    return anySearchSearch(query, key, ctx?.signal);
  }
  throw new Error(`E_SEARCH_ENGINE_NOT_SUPPORTED:${engine}`);
}

toolRegistry.register({
  id: "web_search",
  name: "联网搜索",
  description:
    "搜索互联网获取实时信息。返回搜索结果的标题、链接和摘要。\n\n" +
    "何时用：\n" +
    "- 用户问'最近有什么新闻''搜一下 xxx 怎么用''xxx 是什么'\n" +
    "- 用户问的事需要联网才能知道（股价、赛事、最新技术）\n" +
    "- 用户只给关键词，没给具体网址\n\n" +
    "不要用于：\n" +
    "- 用户已经给了明确网址 -> 用 fetch_url\n" +
    "- 用户问本机文件 -> read_file / list_dir\n" +
    "- 能凭已有知识直接回答的简单问题\n\n" +
    "参数：query（必填，搜索关键词）。",
  enabled: true,
  risk: "network",
  effectKind: "read" as const,
  verificationPolicy: "none" as const,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
    },
    required: ["query"],
  },
  execute: executeWebSearch,
});

toolRegistry.register(createPlayLive2DActionTool({ sendToLive2DWindow }));
