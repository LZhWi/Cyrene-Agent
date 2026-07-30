/**
 * read_file 结构化输出测试
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

// Mock vision-captioner
vi.mock("./vision-captioner", () => ({
  captionImage: vi.fn(),
}));

// 需要在 mock 之后导入
import "./fs-tools";
import { toolRegistry } from "./tool-registry";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-tools-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("read_file structured output", () => {
  it("returns structured JSON with all required fields", async () => {
    const testFile = path.join(tmpDir, "test.txt");
    fs.writeFileSync(testFile, "line 1\nline 2\nline 3\nline 4\nline 5");

    const tool = vi.mocked(toolRegistry.register).mock.calls.find(
      (call) => call[0].id === "read_file",
    )?.[0];
    expect(tool).toBeDefined();

    const result = JSON.parse(await tool!.execute({ path: testFile }));
    expect(result).toHaveProperty("path", testFile);
    expect(result).toHaveProperty("startLine", 1);
    expect(result).toHaveProperty("endLine", 5);
    expect(result).toHaveProperty("totalLines", 5);
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("truncated", false);
  });

  it("respects startLine parameter", async () => {
    const testFile = path.join(tmpDir, "test.txt");
    fs.writeFileSync(testFile, "line 1\nline 2\nline 3\nline 4\nline 5");

    const tool = vi.mocked(toolRegistry.register).mock.calls.find(
      (call) => call[0].id === "read_file",
    )?.[0];

    const result = JSON.parse(await tool!.execute({ path: testFile, startLine: 3 }));
    expect(result.startLine).toBe(3);
    expect(result.endLine).toBe(5);
    expect(result.content).toContain("line 3");
    expect(result.content).not.toContain("  1 | line 1");
  });

  it("respects maxLines parameter", async () => {
    const testFile = path.join(tmpDir, "test.txt");
    fs.writeFileSync(testFile, "line 1\nline 2\nline 3\nline 4\nline 5");

    const tool = vi.mocked(toolRegistry.register).mock.calls.find(
      (call) => call[0].id === "read_file",
    )?.[0];

    const result = JSON.parse(await tool!.execute({ path: testFile, startLine: 2, maxLines: 2 }));
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(3);
    expect(result.totalLines).toBe(5);
  });

  it("handles empty file", async () => {
    const testFile = path.join(tmpDir, "empty.txt");
    fs.writeFileSync(testFile, "");

    const tool = vi.mocked(toolRegistry.register).mock.calls.find(
      (call) => call[0].id === "read_file",
    )?.[0];

    const result = JSON.parse(await tool!.execute({ path: testFile }));
    expect(result.totalLines).toBe(1); // 空文件 split 后有一个空字符串
    expect(result.startLine).toBe(1);
  });

  it("returns error for non-existent file", async () => {
    const tool = vi.mocked(toolRegistry.register).mock.calls.find(
      (call) => call[0].id === "read_file",
    )?.[0];

    const result = JSON.parse(await tool!.execute({ path: "/nonexistent/file.txt" }));
    expect(result.error).toContain("文件不存在");
  });

  it("returns error for relative path", async () => {
    const tool = vi.mocked(toolRegistry.register).mock.calls.find(
      (call) => call[0].id === "read_file",
    )?.[0];

    const result = JSON.parse(await tool!.execute({ path: "relative/path.txt" }));
    expect(result.error).toContain("绝对路径");
  });

  it("returns error for directory", async () => {
    const tool = vi.mocked(toolRegistry.register).mock.calls.find(
      (call) => call[0].id === "read_file",
    )?.[0];

    const result = JSON.parse(await tool!.execute({ path: tmpDir }));
    expect(result.error).toContain("不是文件");
  });

  it("content includes line numbers", async () => {
    const testFile = path.join(tmpDir, "test.txt");
    fs.writeFileSync(testFile, "first\nsecond\nthird");

    const tool = vi.mocked(toolRegistry.register).mock.calls.find(
      (call) => call[0].id === "read_file",
    )?.[0];

    const result = JSON.parse(await tool!.execute({ path: testFile }));
    expect(result.content).toContain("    1 | first");
    expect(result.content).toContain("    2 | second");
    expect(result.content).toContain("    3 | third");
  });

  it("handles CRLF line endings", async () => {
    const testFile = path.join(tmpDir, "crlf.txt");
    fs.writeFileSync(testFile, "line 1\r\nline 2\r\nline 3");

    const tool = vi.mocked(toolRegistry.register).mock.calls.find(
      (call) => call[0].id === "read_file",
    )?.[0];

    const result = JSON.parse(await tool!.execute({ path: testFile }));
    expect(result.totalLines).toBe(3);
  });
});
