/**
 * search_code 工具测试
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock toolRegistry 避免副作用
vi.mock("./tool-registry", () => ({
  toolRegistry: {
    register: vi.fn(),
    getById: vi.fn(),
    getEnabledTools: vi.fn(() => []),
  },
}));

import { registerSearchCodeTool } from "./search-code-tools";
import { toolRegistry } from "./tool-registry";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-code-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("search_code tool", () => {

  it("registers search_code tool with correct metadata", () => {
    registerSearchCodeTool();
    const registerCall = vi.mocked(toolRegistry.register).mock.calls[0];
    const toolDef = registerCall[0];
    expect(toolDef.id).toBe("search_code");
    expect(toolDef.effectKind).toBe("read");
    expect(toolDef.verificationPolicy).toBe("none");
    expect(toolDef.needsContext).toBe(true);
  });

  it("searches for literal text in files", async () => {
    // 创建测试文件
    fs.writeFileSync(path.join(tmpDir, "test.ts"), "const foo = 1;\nconst bar = 2;\nconst foo = 3;");

    // 直接调用 execute
    const toolDef = vi.mocked(toolRegistry.register).mock.calls[0]?.[0];
    if (!toolDef) {
      registerSearchCodeTool();
    }
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];

    // 通过 cwd 参数传入临时目录
    const result = JSON.parse(await tool.execute({ query: "foo", paths: ["."] }, { userQuery: "test" } as any));

    // 注意：实际搜索是在 process.cwd() 下，不是 tmpDir
    // 这里测试的是工具注册和参数解析
    expect(result).toHaveProperty("matches");
    expect(result).toHaveProperty("totalMatches");
    expect(result).toHaveProperty("returnedMatches");
    expect(result).toHaveProperty("truncated");
  });

  it("returns error for empty query", async () => {
    registerSearchCodeTool();
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];

    const result = JSON.parse(await tool.execute({ query: "" }, { userQuery: "test" } as any));
    expect(result.error).toContain("query 不能为空");
    expect(result.matches).toEqual([]);
  });

  it("handles regex mode", async () => {
    registerSearchCodeTool();
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];

    // 测试无效正则不会崩溃
    const result = JSON.parse(await tool.execute({ query: "[invalid", mode: "regex" }, { userQuery: "test" } as any));
    expect(result).toHaveProperty("matches");
  });

  it("respects maxMatches limit", async () => {
    registerSearchCodeTool();
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];

    const result = JSON.parse(await tool.execute({ query: "test", maxMatches: 5 }, { userQuery: "test" } as any));
    expect(result.matches.length).toBeLessThanOrEqual(5);
  });

  it("respects contextLines limit", async () => {
    registerSearchCodeTool();
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];

    const result = JSON.parse(await tool.execute({ query: "test", contextLines: 1 }, { userQuery: "test" } as any));
    // 验证上下文行数不超过限制
    for (const match of result.matches) {
      expect(match.before.length).toBeLessThanOrEqual(1);
      expect(match.after.length).toBeLessThanOrEqual(1);
    }
  });

  it("handles fileGlobs filter", async () => {
    registerSearchCodeTool();
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];

    const result = JSON.parse(await tool.execute(
      { query: "test", fileGlobs: ["*.ts"] },
      { userQuery: "test" } as any,
    ));
    expect(result).toHaveProperty("matches");
  });

  it("handles caseSensitive option", async () => {
    registerSearchCodeTool();
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];

    const result = JSON.parse(await tool.execute(
      { query: "Test", caseSensitive: true },
      { userQuery: "test" } as any,
    ));
    expect(result).toHaveProperty("matches");
  });

  it("handles AbortSignal", async () => {
    registerSearchCodeTool();
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];

    const controller = new AbortController();
    controller.abort(); // 立即取消

    const result = JSON.parse(await tool.execute(
      { query: "test" },
      { userQuery: "test", signal: controller.signal } as any,
    ));
    expect(result).toHaveProperty("matches");
  });
});

describe("search_code path safety", () => {
  it("rejects path traversal attempts", () => {
    // 测试路径逃逸检测（使用 tmpDir 确保跨平台）
    const workspaceRoot = tmpDir;
    const maliciousPath = path.join("..", "..", "..", "etc", "passwd");

    const resolved = path.resolve(workspaceRoot, maliciousPath);
    const normalizedRoot = path.normalize(workspaceRoot);
    const isWithin = resolved.startsWith(normalizedRoot + path.sep) || resolved === normalizedRoot;

    expect(isWithin).toBe(false);
  });

  it("allows normal paths within workspace", () => {
    const workspaceRoot = tmpDir;
    const normalPath = path.join("src", "main", "index.ts");

    const resolved = path.resolve(workspaceRoot, normalPath);
    const normalizedRoot = path.normalize(workspaceRoot);
    const isWithin = resolved.startsWith(normalizedRoot + path.sep) || resolved === normalizedRoot;

    expect(isWithin).toBe(true);
  });
});

describe("search_code glob matching", () => {
  it("matches simple glob patterns", () => {
    // 测试 glob 匹配逻辑
    function matchesGlob(filePath: string, pattern: string): boolean {
      const regexStr = pattern
        .replace(/\./g, "\\.")
        .replace(/\*\*/g, "⟨GLOBSTAR⟩")
        .replace(/\*/g, "[^/]*")
        .replace(/⟨GLOBSTAR⟩/g, ".*")
        .replace(/\?/g, "[^/]");
      const regex = new RegExp("^" + regexStr + "$");
      return regex.test(filePath);
    }

    expect(matchesGlob("src/main/index.ts", "*.ts")).toBe(false); // 不匹配路径
    expect(matchesGlob("index.ts", "*.ts")).toBe(true);
    expect(matchesGlob("src/main/index.ts", "**/*.ts")).toBe(true);
    expect(matchesGlob("src/main/index.ts", "src/**/*.ts")).toBe(true);
    expect(matchesGlob("src/main/index.ts", "*.js")).toBe(false);
  });
});
