import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDirTools, resolveSandboxed } from "./dir-tools";

let rootDir = "";
let outsideDir = "";

function makeTools() {
  const tools = buildDirTools(rootDir);
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  return {
    list: (args: Record<string, unknown> = {}) => byId.get("file_list")!.execute(args),
    read: (args: Record<string, unknown>) => byId.get("file_read")!.execute(args),
    search: (args: Record<string, unknown>) => byId.get("file_search")!.execute(args),
  };
}

describe("dir-tools sandbox", () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-dir-root-"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-dir-outside-"));
    fs.mkdirSync(path.join(rootDir, "src"));
    fs.mkdirSync(path.join(rootDir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src", "app.ts"), "line one\nconst answer = 42;\nline three\n");
    fs.writeFileSync(path.join(rootDir, "README.md"), "# Title\nanswer appears here too\n");
    fs.writeFileSync(path.join(rootDir, "node_modules", "pkg", "secret.txt"), "should be skipped\n");
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top secret\n");
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("rejects ../ escape attempts", () => {
    expect(() => resolveSandboxed(rootDir, "../")).toThrow();
    expect(() => resolveSandboxed(rootDir, path.join("..", "..", "secret"))).toThrow();
  });

  it("allows the root itself and nested relative paths", () => {
    expect(resolveSandboxed(rootDir)).toBe(path.resolve(rootDir));
    expect(resolveSandboxed(rootDir, "./src")).toBe(path.resolve(rootDir, "src"));
  });

  it("rejects absolute paths outside the sandbox", async () => {
    const tools = makeTools();
    const output = await tools.read({ path: path.join(outsideDir, "secret.txt") });
    expect(output).toContain("[错误]");
    expect(output).not.toContain("top secret");
  });

  it("file_list shows entries and skips noise dirs", async () => {
    const output = await makeTools().list();
    expect(output).toContain("src/");
    expect(output).toContain("README.md");
    expect(output).not.toContain("node_modules");
  });

  it("file_read returns numbered lines", async () => {
    const output = await makeTools().read({ path: "src/app.ts" });
    expect(output).toContain("1| line one");
    expect(output).toContain("2| const answer = 42;");
  });

  it("file_read honors startLine/endLine", async () => {
    const output = await makeTools().read({ path: "src/app.ts", startLine: 2, endLine: 2 });
    expect(output).toContain("const answer = 42");
    expect(output).not.toContain("line one");
    expect(output).toContain("第 2-2 行");
  });

  it("file_read reports missing files as errors instead of throwing", async () => {
    const output = await makeTools().read({ path: "missing.txt" });
    expect(output).toContain("[错误]");
    expect(output).toContain("文件不存在");
  });

  it("file_search finds matches with relative path and line number", async () => {
    const output = await makeTools().search({ pattern: "answer" });
    expect(output).toContain("src/app.ts:2:");
    expect(output).toContain("README.md:2:");
    expect(output).not.toContain("node_modules");
  });

  it("file_search falls back to literal match for invalid regex", async () => {
    const output = await makeTools().search({ pattern: "const answer = 42;" });
    expect(output).toContain("src/app.ts:2:");
  });

  it("file_search reports no matches", async () => {
    const output = await makeTools().search({ pattern: "definitely-not-present-xyz" });
    expect(output).toContain("未在");
  });

  it("exposes only read-only safe tools", () => {
    for (const tool of buildDirTools(rootDir)) {
      expect(tool.risk).toBe("safe");
      expect(tool.enabled).toBe(true);
    }
  });
});
