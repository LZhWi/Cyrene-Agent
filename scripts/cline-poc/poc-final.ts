/**
 * Cline SDK PoC 最终验收
 *
 * 工具名来自安装包 DefaultToolName:
 *   read_files | search_codebase | run_commands | fetch_web_content
 *   apply_patch | editor | skills | ask_question | submit_and_exit
 */

import { ClineCore } from "@cline/sdk";
import type { CoreSessionEvent } from "@cline/core";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POC_WORKSPACE = path.resolve(__dirname, "test-workspace");
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || "";
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || "MiniMax-M3";

// ── 实际工具名（来自 @cline/core DefaultToolName）──
const TOOL_READ_FILES = "read_files";
const TOOL_SEARCH_CODEBASE = "search_codebase";
const TOOL_RUN_COMMANDS = "run_commands";
const TOOL_APPLY_PATCH = "apply_patch";
const TOOL_EDITOR = "editor";

// ── 审批记录 ──
const approvalLog: string[] = [];
const toolCallLog: Array<{ tool: string; approved: boolean; detail: string }> = [];

// 命令白名单
const ALLOWED_CMDS = ["npx tsc --noEmit", "npx tsc -p tsconfig.json --noEmit"];

function redact(s: unknown): string {
  try {
    return JSON.stringify(s, (k, v) => {
      if (k === "apiKey" || k === "authorization") return "[REDACTED]";
      if (typeof v === "string" && v.length > 200) return v.slice(0, 200) + "...";
      return v;
    })?.slice(0, 300) || "";
  } catch { return String(s).slice(0, 300); }
}

// ── 审批逻辑 ──
function approve(toolName: string, input: any): { skip?: boolean; reason?: string } | undefined {
  const inputStr = redact(input);

  // read_files / search_codebase: 自动允许
  if (toolName === TOOL_READ_FILES || toolName === TOOL_SEARCH_CODEBASE) {
    console.log(`  [APPROVE auto] ${toolName}`);
    approvalLog.push(`APPROVE auto: ${toolName}`);
    toolCallLog.push({ tool: toolName, approved: true, detail: inputStr });
    return undefined;
  }

  // editor / apply_patch: 文件修改，允许（限制在 workspaceRoot 内由 Cline 保证）
  if (toolName === TOOL_EDITOR || toolName === TOOL_APPLY_PATCH) {
    const fp = String(input?.path || input?.filePath || input?.file_path || "");
    const bn = path.basename(fp);
    console.log(`  [APPROVE modify] ${toolName} file=${bn}`);
    approvalLog.push(`APPROVE modify: ${toolName} file=${bn}`);
    toolCallLog.push({ tool: toolName, approved: true, detail: `file=${bn}` });
    return undefined;
  }

  // run_commands: 逐条检查
  if (toolName === TOOL_RUN_COMMANDS) {
    const cmds = input?.commands;
    if (!Array.isArray(cmds)) {
      console.log(`  [DENY] run_commands: no commands array`);
      approvalLog.push(`DENY run_commands: no commands array`);
      toolCallLog.push({ tool: toolName, approved: false, detail: "no commands array" });
      return { skip: true, reason: "invalid commands" };
    }

    // 逐条检查命令
    for (const cmd of cmds) {
      const cmdStr = typeof cmd === "string" ? cmd : String(cmd?.command || "") + " " + (Array.isArray(cmd?.args) ? cmd.args.join(" ") : "");
      const trimmed = cmdStr.trim();
      const isAllowed = ALLOWED_CMDS.some(allowed => trimmed.includes(allowed));

      if (isAllowed) {
        console.log(`  [APPROVE cmd] ${trimmed}`);
        approvalLog.push(`APPROVE cmd: ${trimmed}`);
      } else {
        console.log(`  [DENY cmd] ${trimmed}`);
        approvalLog.push(`DENY cmd: ${trimmed}`);
        // 拒绝整批命令
        toolCallLog.push({ tool: toolName, approved: false, detail: `denied: ${trimmed}` });
        return { skip: true, reason: `command not allowed: ${trimmed}` };
      }
    }

    // 全部通过
    toolCallLog.push({ tool: toolName, approved: true, detail: `cmds=${cmds.length}` });
    return undefined;
  }

  // 其他工具：拒绝
  console.log(`  [DENY unknown] ${toolName}`);
  approvalLog.push(`DENY unknown: ${toolName}`);
  toolCallLog.push({ tool: toolName, approved: false, detail: "unknown tool" });
  return { skip: true, reason: "tool not in allowlist" };
}

// ── 工作区 ──
function setup(): void {
  fs.mkdirSync(POC_WORKSPACE, { recursive: true });
  fs.writeFileSync(path.join(POC_WORKSPACE, "package.json"), JSON.stringify({
    name: "cline-poc-test", version: "1.0.0", type: "module",
  }, null, 2));
  fs.writeFileSync(path.join(POC_WORKSPACE, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "bundler",
      strict: true, noEmit: true, skipLibCheck: true,
    },
    include: ["*.ts"],
  }, null, 2));
  fs.writeFileSync(path.join(POC_WORKSPACE, "test-file.ts"),
    `export function greet(name: string): string {\n  return "hello " + name;\n}\n`);
}

function cleanup(): void {
  try { fs.rmSync(POC_WORKSPACE, { recursive: true, force: true }); } catch {}
}

// ── 主任务 ──
async function runMain(): Promise<void> {
  console.log("\n════════════════════════════════════════");
  console.log("最终验收 PoC");
  console.log("════════════════════════════════════════");
  console.log("Provider: openai-compatible");
  console.log("Model:", MINIMAX_MODEL);
  console.log("baseUrl:", MINIMAX_BASE_URL);
  console.log("apiKey: SET");

  if (!MINIMAX_API_KEY) { console.error("错误: 未设置 MINIMAX_API_KEY"); process.exit(1); }

  setup();
  let cline: ClineCore | null = null;
  let eventCount = 0;
  const allEvents: any[] = [];

  try {
    cline = await ClineCore.create({ clientName: "poc-final", backendMode: "local" });

    const unsubscribe = cline.subscribe((event: CoreSessionEvent) => {
      eventCount++;
      allEvents.push(event);

      const t = event.type;
      if (t === "agent_event") {
        const ae = (event as any).payload?.event;
        const innerType = ae?.type || "?";
        const ct = ae?.contentType || "?";
        const tn = ae?.toolName || "";

        if (ct === "tool" || tn) {
          if (innerType === "content_start") {
            console.log(`  [TOOL_START] ${tn} callId=${ae?.toolCallId || "?"}`);
          } else if (innerType === "content_end") {
            const out = redact(ae?.output).slice(0, 100);
            console.log(`  [TOOL_END] ${tn} err=${ae?.error || "none"} ${ae?.durationMs || 0}ms out=${out}`);
          }
        } else if (innerType === "iteration_end") {
          console.log(`  [ITER_END] #${ae?.iteration} toolCalls=${ae?.toolCallCount}`);
        } else if (innerType === "done") {
          console.log(`  [DONE]`);
        } else if (innerType === "error") {
          console.log(`  [ERROR] ${String(ae?.error || ae?.message || "").slice(0, 100)}`);
        }
      } else if (t === "hook") {
        const p = (event as any).payload;
        console.log(`  [HOOK] ${p?.hookEventName} tool=${p?.toolName || "?"}`);
      } else if (t === "status") {
        console.log(`  [STATUS] ${(event as any).payload?.status}`);
      } else if (t === "ended") {
        console.log(`  [ENDED] ${(event as any).payload?.reason}`);
      } else if (t === "chunk") {
        const p = (event as any).payload;
        if (p?.stream === "stdout") console.log(`  [STDOUT] ${p.chunk.slice(0, 200)}`);
        else if (p?.stream === "stderr") console.log(`  [STDERR] ${p.chunk.slice(0, 200)}`);
      }
    });

    console.log("\n启动会话...");

    const result = await cline.start({
      config: {
        providerId: "openai-compatible",
        modelId: MINIMAX_MODEL,
        apiKey: MINIMAX_API_KEY,
        baseUrl: MINIMAX_BASE_URL,
        cwd: POC_WORKSPACE,
        workspaceRoot: POC_WORKSPACE,
        systemPrompt: "你是一个代码助手。请帮助用户完成代码任务。",
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        hooks: {
          beforeTool: (ctx: any) => {
            const toolName = ctx?.tool?.name || "unknown";
            const input = ctx?.input;
            console.log(`  [BEFORE_TOOL] ${toolName}`);
            return approve(toolName, input);
          },
        },
      },
      toolPolicies: {
        read_files: { enabled: true, autoApprove: true },
        search_codebase: { enabled: true, autoApprove: true },
        run_commands: { enabled: true, autoApprove: true },
        apply_patch: { enabled: true, autoApprove: true },
        editor: { enabled: true, autoApprove: true },
      },
      prompt: `请完成以下任务：
1. 读取 test-file.ts 文件内容
2. 将 greet 函数返回值从 "hello " + name 改为 "hello cline: " + name
3. 运行 npx tsc --noEmit 验证类型检查
4. 尝试运行 ls -la（这应该被拒绝）
5. 报告验证结果`,
    });

    console.log("\n════ 主任务完成 ════");
    console.log("sessionId:", result.sessionId);
    console.log("总事件数:", eventCount);

    // ── 文件检查 ──
    const testFile = path.join(POC_WORKSPACE, "test-file.ts");
    if (fs.existsSync(testFile)) {
      const content = fs.readFileSync(testFile, "utf8");
      console.log("\n════ 文件检查 ════");
      console.log("包含 'hello cline':", content.includes("hello cline") ? "✅" : "❌");
      console.log("文件内容:\n", content);
    }

    // ── 工作区文件 ──
    console.log("工作区文件:", fs.readdirSync(POC_WORKSPACE));

    // ── tsc 证据 ──
    console.log("\n════ tsc 证据 ════");
    const stdout = allEvents
      .filter((e: any) => e.type === "chunk" && e.payload?.stream === "stdout")
      .map((e: any) => e.payload.chunk).join("");
    const stderr = allEvents
      .filter((e: any) => e.type === "chunk" && e.payload?.stream === "stderr")
      .map((e: any) => e.payload.chunk).join("");
    console.log("stdout:", stdout.slice(0, 500) || "(空)");
    console.log("stderr:", stderr.slice(0, 500) || "(空)");

    // 检查 run_commands 工具事件
    const cmdTools = allEvents
      .filter((e: any) => e.type === "agent_event" && e.payload?.event?.toolName === "run_commands")
      .map((e: any) => e.payload.event);
    console.log("run_commands 调用数:", cmdTools.length);
    for (const ct of cmdTools) {
      if (ct.type === "content_end") {
        console.log("  run_commands 结果:", redact(ct.output).slice(0, 200));
      }
    }

    // ── 审批日志 ──
    console.log("\n════ 审批日志 ════");
    for (const log of approvalLog) {
      console.log(" ", log);
    }

    // ── 工具调用汇总 ──
    console.log("\n════ 工具调用汇总 ════");
    for (const tc of toolCallLog) {
      console.log(`  ${tc.tool} approved=${tc.approved} ${tc.detail}`);
    }

    // ── 验收检查 ──
    console.log("\n════ 验收检查 ════");
    const hasRead = approvalLog.some(l => l.includes("APPROVE auto: read_files"));
    const hasModify = approvalLog.some(l => l.includes("APPROVE modify"));
    const hasTsc = approvalLog.some(l => l.includes("APPROVE cmd") && l.includes("tsc"));
    const hasDeniedCmd = approvalLog.some(l => l.includes("DENY cmd") || l.includes("DENY unknown"));
    const fileModified = fs.existsSync(testFile) && fs.readFileSync(testFile, "utf8").includes("hello cline");

    // tsc 执行证据：检查 run_commands 工具结果中是否包含 tsc 且无错误
    const tscResults = cmdTools
      .filter((ct: any) => ct.type === "content_end")
      .map((ct: any) => String(ct.output || ""))
      .filter((s: string) => s.includes("tsc"));
    const tscExecuted = tscResults.length > 0;
    const tscExitZero = tscResults.some((s: string) =>
      s.includes('"exitCode":0') || s.includes('"exit_code":0') || s.includes('"exitCode": 0') || (!s.includes("error") && !s.includes("Error"))
    );

    console.log("read_files approved:", hasRead ? "✅" : "❌");
    console.log("file modify approved:", hasModify ? "✅" : "❌");
    console.log("npx tsc --noEmit approved:", hasTsc ? "✅" : "❌");
    console.log("non-whitelist command denied:", hasDeniedCmd ? "✅" : "❌");
    console.log("file actually modified:", fileModified ? "✅" : "❌");
    console.log("tsc command executed:", tscExecuted ? "✅" : "❌");
    console.log("tsc exitCode === 0:", tscExitZero ? "✅" : "❌");

    unsubscribe();
  } catch (err) {
    console.error("错误:", err);
  } finally {
    if (cline) { try { await cline.dispose(); } catch {} }
    cleanup();
  }
}

// ── 运行 ──
async function main(): Promise<void> {
  await runMain();
  console.log("\n════════════════════════════════════════");
  console.log("PoC 最终验收结束");
  console.log("════════════════════════════════════════");
}

main().catch((err) => {
  console.error("致命错误:", err);
  process.exit(1);
});
