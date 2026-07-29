/**
 * Cline 适配层 - 单元测试
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { isWithinWorkspace, normalizeWorkspaceRoot } from "./workspace-guard";
import { checkCommands, DEFAULT_COMMAND_ALLOW_LIST, parseCommand, hasShellMetacharacters } from "./command-guard";
import { ThinkFilter } from "./think-filter";
import { acquireWorkspaceLock, releaseWorkspaceLock } from "./workspace-lock";
import { createStreamState, buildVerification } from "./event-handler";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════
// workspace-guard
// ══════════════════════════════════════════════════════════════

describe("workspace-guard", () => {
  it("allows file within workspace", () => {
    const file = path.join(tmpDir, "test.ts");
    fs.writeFileSync(file, "test");
    expect(isWithinWorkspace(file, tmpDir)).toBe(true);
  });

  it("rejects file outside workspace (..)", () => {
    const outside = path.join(tmpDir, "..", "outside.ts");
    expect(isWithinWorkspace(outside, tmpDir)).toBe(false);
  });

  it("rejects absolute path outside workspace", () => {
    const outside = path.join(os.tmpdir(), "other-project", "file.ts");
    expect(isWithinWorkspace(outside, tmpDir)).toBe(false);
  });

  it("allows non-existent file within workspace (parent exists)", () => {
    const file = path.join(tmpDir, "src", "new-file.ts");
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    expect(isWithinWorkspace(file, tmpDir)).toBe(true);
  });

  it("rejects non-existent file outside workspace", () => {
    const file = path.join(tmpDir, "..", "..", "outside.ts");
    expect(isWithinWorkspace(file, tmpDir)).toBe(false);
  });

  it("rejects relative path", () => {
    expect(isWithinWorkspace("relative/path.ts", tmpDir)).toBe(false);
  });

  it("rejects empty path", () => {
    expect(isWithinWorkspace("", tmpDir)).toBe(false);
  });

  it("rejects workspaceRoot itself", () => {
    expect(isWithinWorkspace(tmpDir, tmpDir)).toBe(false);
  });

  it("normalizeWorkspaceRoot returns realpath", () => {
    const result = normalizeWorkspaceRoot(tmpDir);
    expect(path.isAbsolute(result)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// command-guard
// ══════════════════════════════════════════════════════════════

describe("command-guard", () => {
  it("allows npx tsc --noEmit", () => {
    expect(checkCommands(["npx tsc --noEmit"])).toBeUndefined();
  });

  it("allows npx tsc -p tsconfig.json --noEmit", () => {
    expect(checkCommands(["npx tsc -p tsconfig.json --noEmit"])).toBeUndefined();
  });

  it("allows npm test", () => {
    expect(checkCommands(["npm test"])).toBeUndefined();
  });

  it("rejects ls -la", () => {
    const result = checkCommands(["ls -la"]);
    expect(result?.skip).toBe(true);
  });

  it("rejects echo test", () => {
    const result = checkCommands(["echo test"]);
    expect(result?.skip).toBe(true);
  });

  it("rejects && chaining", () => {
    const result = checkCommands(["npx tsc --noEmit && echo done"]);
    expect(result?.skip).toBe(true);
  });

  it("rejects pipe", () => {
    const result = checkCommands(["npx tsc --noEmit | grep error"]);
    expect(result?.skip).toBe(true);
  });

  it("rejects redirect", () => {
    const result = checkCommands(["npx tsc --noEmit > output.txt"]);
    expect(result?.skip).toBe(true);
  });

  it("rejects cmd wrapper", () => {
    const result = checkCommands(["cmd /c npx tsc --noEmit"]);
    expect(result?.skip).toBe(true);
  });

  it("rejects PowerShell wrapper", () => {
    const result = checkCommands(["powershell -Command npx tsc"]);
    expect(result?.skip).toBe(true);
  });

  it("rejects cd", () => {
    const result = checkCommands(["cd /tmp && npx tsc"]);
    expect(result?.skip).toBe(true);
  });

  it("rejects invalid format", () => {
    const result = checkCommands("not an array");
    expect(result?.skip).toBe(true);
  });

  it("rejects empty command", () => {
    const result = checkCommands([""]);
    expect(result?.skip).toBe(true);
  });

  it("allows structured command object", () => {
    const result = checkCommands([{ command: "npx", args: ["tsc", "--noEmit"] }]);
    expect(result).toBeUndefined();
  });

  it("DEFAULT_COMMAND_ALLOW_LIST has no duplicate npx", () => {
    const npxEntries = DEFAULT_COMMAND_ALLOW_LIST.executables.filter(e => e.name === "npx");
    expect(npxEntries.length).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════
// think-filter
// ══════════════════════════════════════════════════════════════

describe("ThinkFilter", () => {
  it("passes through plain text", () => {
    const filter = new ThinkFilter();
    expect(filter.process("hello world")).toBe("hello world");
  });

  it("filters <think>...</think>", () => {
    const filter = new ThinkFilter();
    filter.process("before");
    filter.process("<think>secret</think>");
    const result = filter.process("after");
    expect(result).toContain("after");
    expect(result).not.toContain("secret");
  });

  it("handles split <think> tag", () => {
    const filter = new ThinkFilter();
    const out1 = filter.process("text<thi");
    const out2 = filter.process("nk>hidden</think>more");
    expect(out1).toBe("text");
    expect(out2).toBe("more");
  });

  it("handles split </think> tag", () => {
    const filter = new ThinkFilter();
    filter.process("<think>secret</thi");
    const out = filter.process("nk>visible");
    expect(out).toBe("visible");
  });

  it("flush returns remaining non-think text", () => {
    const filter = new ThinkFilter();
    // 通过 process 注入文本（无 <think> 标签前缀），然后 flush
    filter.process("remaining text");
    // process 已经输出全部文本（无部分标签前缀），flush 返回空
    // 改为测试有部分标签前缀被保留的情况
    const filter2 = new ThinkFilter();
    filter2.process("text<thi"); // <thi 是 <think> 的部分前缀
    // process 输出 "text"，buffer 保留 "<thi"
    // flush 时不在 think 内，输出剩余
    expect(filter2.flush()).toBe("<thi");
  });

  it("flush does not return think content", () => {
    const filter = new ThinkFilter();
    filter.process("<think>secret");
    expect(filter.flush()).toBe("");
  });

  it("handles multiple <think> blocks", () => {
    const filter = new ThinkFilter();
    const out = filter.process("a<think>1</think>b<think>2</think>c");
    expect(out).toBe("abc");
  });

  it("handles empty <think></think>", () => {
    const filter = new ThinkFilter();
    const out = filter.process("a<think></think>b");
    expect(out).toBe("ab");
  });
});

// ══════════════════════════════════════════════════════════════
// workspace-lock
// ══════════════════════════════════════════════════════════════

describe("workspace-lock", () => {
  it("acquires and releases lock", () => {
    const key = acquireWorkspaceLock(tmpDir, "session-1");
    expect(key).toBeDefined();
    releaseWorkspaceLock(key);
  });

  it("prevents double acquire", () => {
    const key = acquireWorkspaceLock(tmpDir, "session-1");
    expect(() => acquireWorkspaceLock(tmpDir, "session-2")).toThrow("WORKSPACE_LOCKED");
    releaseWorkspaceLock(key);
  });

  it("allows re-acquire after release", () => {
    const key1 = acquireWorkspaceLock(tmpDir, "session-1");
    releaseWorkspaceLock(key1);
    const key2 = acquireWorkspaceLock(tmpDir, "session-2");
    expect(key2).toBeDefined();
    releaseWorkspaceLock(key2);
  });
});

// ══════════════════════════════════════════════════════════════
// event-handler
// ══════════════════════════════════════════════════════════════

describe("event-handler", () => {
  it("createStreamState initializes correctly", () => {
    const state = createStreamState(tmpDir);
    expect(state.workspaceRoot).toBe(tmpDir);
    expect(state.textMessageOpen).toBe(false);
    expect(state.toolCalls.size).toBe(0);
    expect(state.changedFiles.size).toBe(0);
    expect(state.hasPotentialSideEffects).toBe(false);
  });

  it("buildVerification returns not attempted when no tsc", () => {
    const state = createStreamState(tmpDir);
    const result = buildVerification(state);
    expect(result.attempted).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("buildVerification returns passed when tsc exitCode=0", () => {
    const state = createStreamState(tmpDir);
    state.commands.push({ command: "npx tsc --noEmit", exitCode: 0, stdout: "", stderr: "" });
    const result = buildVerification(state);
    expect(result.attempted).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("buildVerification returns failed when tsc exitCode=1", () => {
    const state = createStreamState(tmpDir);
    state.commands.push({ command: "npx tsc --noEmit", exitCode: 1, stdout: "", stderr: "error" });
    const result = buildVerification(state);
    expect(result.attempted).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.details).toBe("error");
  });
});
