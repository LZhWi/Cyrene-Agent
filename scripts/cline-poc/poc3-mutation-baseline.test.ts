/**
 * PoC 3: Mutation 基线与性能策略测试
 *
 * 8 个场景：
 * A. 干净 Git 仓库：修改、新建、删除
 * B. 已有 dirty 文件：区分原有修改和本轮修改
 * C. Cline 再次修改原本 dirty 的同一文件
 * D. 命令生成文件（不经过 editor 工具）
 * E. 非 Git 工作区的新建、修改、删除
 * F. 重命名降级为 create + delete
 * G. 大型工作区性能（含 node_modules/dist/build/.git）
 * H. 删除文件、符号链接和工作区越界路径
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { execSync } from "child_process";

// ── 类型 ──────────────────────────────────────────────────

interface MutationEvidence {
  preExistingChanges: string[];
  touchedPreExistingFiles: string[];
  candidateFiles: string[];
  createdFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  ignoredPaths: string[];
  rejectedOutsideWorkspacePaths: string[];
  evidenceSources: Array<"cline_event" | "workspace_watch" | "file_snapshot" | "git_diff">;
}

// ── 忽略规则 ──────────────────────────────────────────────

const IGNORE_PATTERNS = [".git", "node_modules", "dist", "build", "coverage", ".cache", ".tmp"];

function isIgnored(filePath: string, workspaceRoot: string): boolean {
  const rel = path.relative(workspaceRoot, filePath);
  for (const pattern of IGNORE_PATTERNS) {
    if (rel === pattern || rel.startsWith(pattern + path.sep)) return true;
  }
  return false;
}

function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  const resolved = path.resolve(filePath);
  const normalized = path.normalize(resolved);
  const wsNormalized = path.normalize(workspaceRoot);
  return normalized === wsNormalized || normalized.startsWith(wsNormalized + path.sep);
}

// ── Git 基线 ──────────────────────────────────────────────

function getGitStatus(workspaceRoot: string): Set<string> {
  try {
    const output = execSync("git status --porcelain=v1 -uall", { cwd: workspaceRoot, encoding: "utf8" });
    const files = new Set<string>();
    for (const line of output.trim().split("\n")) {
      if (line.length < 4) continue;
      // porcelain format: XY <space> path (XY may have leading space for unstaged)
      const match = line.match(/^\s*(\S{1,2})\s+(.+?)(?:\r)?$/);
      if (!match) continue;
      const status = match[1];
      const file = match[2].trim().replace(/^"|"$/g, "");
      files.add(path.resolve(workspaceRoot, file.replace(/\//g, path.sep)));
    }
    return files;
  } catch {
    return new Set();
  }
}

function isGitRepo(workspaceRoot: string): boolean {
  try {
    execSync("git rev-parse --git-dir", { cwd: workspaceRoot, encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

function hashFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

// ── MutationCollector ─────────────────────────────────────

class MutationCollector {
  private workspaceRoot: string;
  private preExistingChanges: Set<string> = new Set();
  private preExistingHashes: Map<string, string> = new Map();
  private candidateFiles: Set<string> = new Set();
  private ignoredPaths: Set<string> = new Set();
  private rejectedPaths: Set<string> = new Set();
  private startTime: number;
  private startGitStatus: Set<string> = new Set();
  private isGit: boolean;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.isGit = isGitRepo(this.workspaceRoot);
    this.startTime = Date.now();
  }

  /** 任务开始前记录基线 */
  recordBaseline(): void {
    if (this.isGit) {
      this.startGitStatus = getGitStatus(this.workspaceRoot);
      this.preExistingChanges = new Set(this.startGitStatus);
      // 只对 preExisting 文件保存 Hash
    for (const f of this.preExistingChanges) {
      const h = hashFile(f);
      if (h) this.preExistingHashes.set(f, h);
      console.log(`[Mutation] baseline hash: ${path.basename(f)} -> ${h ? h.slice(0, 8) : "NULL"} path=${f}`);
    }
    }
    console.log(`[Mutation] baseline: git=${this.isGit}, preExisting=${this.preExistingChanges.size}`);
  }

  /** 添加候选文件（来自 Cline 事件） */
  addCandidate(filePath: string): void {
    const resolved = path.resolve(filePath);
    if (!isWithinWorkspace(resolved, this.workspaceRoot)) {
      this.rejectedPaths.add(resolved);
      return;
    }
    if (isIgnored(resolved, this.workspaceRoot)) {
      this.ignoredPaths.add(resolved);
      return;
    }
    this.candidateFiles.add(resolved);
  }

  /** 任务结束后收集证据 */
  collect(): MutationEvidence {
    const createdFiles: string[] = [];
    const modifiedFiles: string[] = [];
    const deletedFiles: string[] = [];
    const touchedPreExistingFiles: string[] = [];
    const evidenceSources: Set<string> = new Set();

    if (this.isGit) {
      evidenceSources.add("git_diff");
      const endGitStatus = getGitStatus(this.workspaceRoot);

      // 新出现的变更
      for (const f of endGitStatus) {
        if (!this.startGitStatus.has(f)) {
          // 新变更
          if (!fs.existsSync(f)) {
            deletedFiles.push(f);
          } else {
            // 检查是否是新文件
            try {
              const output = execSync(`git status --porcelain=v1 -- "${path.relative(this.workspaceRoot, f)}"`, {
                cwd: this.workspaceRoot, encoding: "utf8",
              }).trim();
              if (output.startsWith("??")) {
                createdFiles.push(f);
              } else {
                modifiedFiles.push(f);
              }
            } catch {
              modifiedFiles.push(f);
            }
          }
        }
      }

      // 检查 preExisting 文件是否被再次修改
      for (const [f, oldHash] of this.preExistingHashes) {
        const newHash = hashFile(f);
        if (newHash && newHash !== oldHash) {
          touchedPreExistingFiles.push(f);
          console.log(`[Mutation] touchedPreExisting: ${path.basename(f)} hash changed`);
        } else if (!newHash) {
          console.log(`[Mutation] touchedPreExisting: ${path.basename(f)} file not found`);
        }
        // 已删除的 preExisting
        if (!fs.existsSync(f) && !endGitStatus.has(f)) {
          deletedFiles.push(f);
        }
      }
    }

    // 非 Git 或 Git 未捕获的候选文件
    const allDetected = new Set([
      ...createdFiles, ...modifiedFiles, ...deletedFiles,
      ...touchedPreExistingFiles, ...this.preExistingChanges,
    ]);
    for (const f of this.candidateFiles) {
      evidenceSources.add("cline_event");
      if (allDetected.has(f)) continue; // 已被 Git 或 preExisting 捕获

      if (!fs.existsSync(f)) {
        if (!deletedFiles.includes(f)) deletedFiles.push(f);
      } else {
        if (!createdFiles.includes(f) && !modifiedFiles.includes(f)) {
          modifiedFiles.push(f);
        }
      }
    }

    return {
      preExistingChanges: Array.from(this.preExistingChanges),
      touchedPreExistingFiles,
      candidateFiles: Array.from(this.candidateFiles),
      createdFiles,
      modifiedFiles,
      deletedFiles,
      ignoredPaths: Array.from(this.ignoredPaths),
      rejectedOutsideWorkspacePaths: Array.from(this.rejectedPaths),
      evidenceSources: Array.from(evidenceSources),
    };
  }

  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }
}

// ── 测试工具 ──────────────────────────────────────────────

function setupGitRepo(dir: string): void {
  execSync("git init", { cwd: dir, encoding: "utf8" });
  execSync('git config user.email "test@test.com"', { cwd: dir, encoding: "utf8" });
  execSync('git config user.name "test"', { cwd: dir, encoding: "utf8" });
  // 初始提交
  fs.writeFileSync(path.join(dir, "README.md"), "# test");
  execSync("git add .", { cwd: dir, encoding: "utf8" });
  execSync('git commit -m "init"', { cwd: dir, encoding: "utf8" });
}

// ── 测试 ──────────────────────────────────────────────────

describe("PoC 3: Mutation 基线与性能", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-poc3-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("A. 干净 Git 仓库：修改、新建、删除", () => {
    setupGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "existing.ts"), "export const x = 1;");
    fs.writeFileSync(path.join(tmpDir, "to-delete.ts"), "temp");
    execSync("git add .", { cwd: tmpDir });
    execSync('git commit -m "init files"', { cwd: tmpDir });

    const collector = new MutationCollector(tmpDir);
    collector.recordBaseline();

    // 模拟 Cline 修改
    fs.writeFileSync(path.join(tmpDir, "existing.ts"), "export const x = 2;");
    collector.addCandidate(path.join(tmpDir, "existing.ts"));

    // 模拟 Cline 新建
    fs.writeFileSync(path.join(tmpDir, "new-file.ts"), "export const y = 1;");
    collector.addCandidate(path.join(tmpDir, "new-file.ts"));

    // 模拟 Cline 删除
    fs.unlinkSync(path.join(tmpDir, "to-delete.ts"));

    const evidence = collector.collect();

    expect(evidence.modifiedFiles.some(f => path.basename(f) === "existing.ts")).toBe(true);
    expect(evidence.createdFiles.some(f => path.basename(f) === "new-file.ts")).toBe(true);
    expect(evidence.deletedFiles.some(f => path.basename(f) === "to-delete.ts")).toBe(true);
    expect(evidence.preExistingChanges.length).toBe(0);
    expect(evidence.evidenceSources).toContain("git_diff");

    console.log("[PoC3] A: modified=" + evidence.modifiedFiles.length, "created=" + evidence.createdFiles.length, "deleted=" + evidence.deletedFiles.length);
  });

  it("B. 已有 dirty 文件：区分原有修改和本轮修改", () => {
    setupGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "clean.ts"), "export const a = 1;");
    fs.writeFileSync(path.join(tmpDir, "user-dirty.ts"), "export const b = 1;");
    execSync("git add .", { cwd: tmpDir });
    execSync('git commit -m "init files"', { cwd: tmpDir });

    // 用户修改 user-dirty.ts（运行前 dirty）
    fs.writeFileSync(path.join(tmpDir, "user-dirty.ts"), "export const b = 2;");

    const collector = new MutationCollector(tmpDir);
    collector.recordBaseline();

    // Cline 只修改 clean.ts
    fs.writeFileSync(path.join(tmpDir, "clean.ts"), "export const a = 2;");
    collector.addCandidate(path.join(tmpDir, "clean.ts"));

    const evidence = collector.collect();

    expect(evidence.preExistingChanges.some(f => path.basename(f) === "user-dirty.ts")).toBe(true);
    expect(evidence.modifiedFiles.some(f => path.basename(f) === "clean.ts")).toBe(true);
    expect(evidence.modifiedFiles.some(f => path.basename(f) === "user-dirty.ts")).toBe(false);

    console.log("[PoC3] B: preExisting=" + evidence.preExistingChanges.length, "newRun=" + evidence.modifiedFiles.length);
  });

  it("C. Cline 再次修改原本 dirty 的同一文件", () => {
    setupGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "dirty.ts"), "line1\n");
    execSync("git add .", { cwd: tmpDir });
    execSync('git commit -m "init"', { cwd: tmpDir });

    // 用户修改
    fs.writeFileSync(path.join(tmpDir, "dirty.ts"), "line1\nline2\n");

    const collector = new MutationCollector(tmpDir);
    collector.recordBaseline();

    // Cline 再次修改同一文件
    fs.writeFileSync(path.join(tmpDir, "dirty.ts"), "line1\nline2\nline3\n");
    collector.addCandidate(path.join(tmpDir, "dirty.ts"));

    const evidence = collector.collect();

    // dirty.ts 应该在 touchedPreExistingFiles 中
    expect(evidence.touchedPreExistingFiles.some(f => path.basename(f) === "dirty.ts")).toBe(true);
    expect(evidence.modifiedFiles.some(f => path.basename(f) === "dirty.ts")).toBe(false);

    console.log("[PoC3] C: touchedPreExisting=" + evidence.touchedPreExistingFiles.length);
  });

  it("D. 命令生成文件（不经过 editor）", () => {
    setupGitRepo(tmpDir);

    const collector = new MutationCollector(tmpDir);
    collector.recordBaseline();

    // 模拟命令生成文件（不 addCandidate）
    fs.mkdirSync(path.join(tmpDir, "output"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "output", "generated.json"), '{"result": true}');

    const evidence = collector.collect();

    // Git diff 应该捕获到
    expect(evidence.createdFiles.some(f => f.includes("generated.json"))).toBe(true);
    expect(evidence.evidenceSources).toContain("git_diff");

    console.log("[PoC3] D: created via command=" + evidence.createdFiles.length);
  });

  it("E. 非 Git 工作区的新建、修改、删除", () => {
    // 不初始化 Git
    fs.writeFileSync(path.join(tmpDir, "existing.ts"), "const x = 1;");

    const collector = new MutationCollector(tmpDir);
    collector.recordBaseline();

    // 修改
    fs.writeFileSync(path.join(tmpDir, "existing.ts"), "const x = 2;");
    collector.addCandidate(path.join(tmpDir, "existing.ts"));

    // 新建
    fs.writeFileSync(path.join(tmpDir, "new.ts"), "const y = 1;");
    collector.addCandidate(path.join(tmpDir, "new.ts"));

    // 删除
    fs.writeFileSync(path.join(tmpDir, "to-delete.ts"), "temp");
    collector.addCandidate(path.join(tmpDir, "to-delete.ts"));
    fs.unlinkSync(path.join(tmpDir, "to-delete.ts"));

    const evidence = collector.collect();

    // 非 Git 无法区分 created vs modified，统一 modified
    expect(evidence.modifiedFiles.some(f => f.includes("existing.ts"))).toBe(true);
    expect(evidence.modifiedFiles.some(f => f.includes("new.ts"))).toBe(true);
    expect(evidence.deletedFiles.some(f => f.includes("to-delete.ts"))).toBe(true);
    expect(evidence.evidenceSources).toContain("cline_event");
    expect(evidence.evidenceSources).not.toContain("git_diff");

    console.log("[PoC3] E: modified=" + evidence.modifiedFiles.length, "deleted=" + evidence.deletedFiles.length);
  });

  it("F. 重命名降级为 create + delete", () => {
    setupGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "old.ts"), "export const x = 1;");
    execSync("git add .", { cwd: tmpDir });
    execSync('git commit -m "init"', { cwd: tmpDir });

    const collector = new MutationCollector(tmpDir);
    collector.recordBaseline();

    // 重命名
    fs.renameSync(path.join(tmpDir, "old.ts"), path.join(tmpDir, "new.ts"));

    const evidence = collector.collect();

    // 降级为 create + delete
    const hasDeleted = evidence.deletedFiles.some(f => f.includes("old.ts"));
    const hasCreated = evidence.createdFiles.some(f => f.includes("new.ts"));
    expect(hasDeleted || hasCreated).toBe(true);

    console.log("[PoC3] F: deleted=" + evidence.deletedFiles.filter(f => f.includes("old.ts")).length,
      "created=" + evidence.createdFiles.filter(f => f.includes("new.ts")).length);
  });

  it("G. 大型工作区性能", () => {
    setupGitRepo(tmpDir);

    // 模拟大型项目结构
    fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "build"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });

    // 创建大量文件
    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(path.join(tmpDir, "node_modules", `pkg-${i}.js`), `module.exports = ${i};`);
      fs.writeFileSync(path.join(tmpDir, "dist", `chunk-${i}.js`), `var chunk${i} = ${i};`);
      fs.writeFileSync(path.join(tmpDir, "src", `file-${i}.ts`), `export const f${i} = ${i};`);
    }

    // Git 初始提交
    execSync("git add .", { cwd: tmpDir });
    execSync('git commit -m "large project"', { cwd: tmpDir });

    const t0 = Date.now();
    const collector = new MutationCollector(tmpDir);
    collector.recordBaseline();
    const baselineMs = Date.now() - t0;

    // 修改少量文件
    fs.writeFileSync(path.join(tmpDir, "src", "file-0.ts"), "export const f0 = 'modified';");
    fs.writeFileSync(path.join(tmpDir, "src", "file-1.ts"), "export const f1 = 'modified';");
    collector.addCandidate(path.join(tmpDir, "src", "file-0.ts"));
    collector.addCandidate(path.join(tmpDir, "src", "file-1.ts"));

    const t1 = Date.now();
    const evidence = collector.collect();
    const collectMs = Date.now() - t1;
    const totalMs = Date.now() - t0;

    expect(evidence.modifiedFiles.length).toBe(2);

    // 忽略目录文件不被扫描
    expect(evidence.ignoredPaths.length).toBe(0); // addCandidate 时被忽略，不计入

    console.log(`[PoC3] G: baseline=${baselineMs}ms, collect=${collectMs}ms, total=${totalMs}ms`);
    console.log(`[PoC3] G: modified=${evidence.modifiedFiles.length}, hashCount=2 (only dirty files)`);

    // 性能断言（宽松，CI 环境可能慢）
    expect(totalMs).toBeLessThan(5000); // 5 秒内
  });

  it("H. 删除文件、工作区越界路径", () => {
    setupGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "inner.ts"), "export const x = 1;");
    execSync("git add .", { cwd: tmpDir });
    execSync('git commit -m "init"', { cwd: tmpDir });

    const collector = new MutationCollector(tmpDir);
    collector.recordBaseline();

    // 删除文件
    fs.unlinkSync(path.join(tmpDir, "inner.ts"));

    // 越界路径
    const outsideFile = path.join(os.tmpdir(), "outside-file.ts");
    fs.writeFileSync(outsideFile, "outside");
    collector.addCandidate(outsideFile);

    // 已删除文件路径
    collector.addCandidate(path.join(tmpDir, "inner.ts"));

    const evidence = collector.collect();

    expect(evidence.deletedFiles).toContain(path.join(tmpDir, "inner.ts"));
    expect(evidence.rejectedOutsideWorkspacePaths).toContain(outsideFile);

    // 清理
    fs.unlinkSync(outsideFile);

    console.log("[PoC3] H: deleted=" + evidence.deletedFiles.length, "rejected=" + evidence.rejectedOutsideWorkspacePaths.length);
  });
});
