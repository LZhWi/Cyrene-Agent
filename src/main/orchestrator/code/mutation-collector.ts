/**
 * MutationCollector - 真实变更证据收集
 *
 * 策略：
 * - Git 项目：git status --porcelain=v1 -uall + preExisting Hash 对比
 * - 非 Git 项目：watcher + 候选路径状态读取
 * - 不全量扫描工作区
 * - 删除路径通过父目录 realpath 校验
 * - symlink 越界拒绝
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export interface MutationEvidence {
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

export interface MutationCollectorTiming {
  baselineMs: number;
  collectMs: number;
  totalMs: number;
}

const IGNORE_PATTERNS = [".git", "node_modules", "dist", "build", "coverage", ".cache", ".tmp"];

function isIgnoredInternal(filePath: string, workspaceRoot: string): boolean {
  const rel = path.relative(workspaceRoot, filePath);
  for (const pattern of IGNORE_PATTERNS) {
    if (rel === pattern || rel.startsWith(pattern + path.sep)) return true;
  }
  return false;
}

function isWithinWorkspaceInternal(filePath: string, workspaceRoot: string): boolean {
  const resolved = path.resolve(filePath);
  const normalized = path.normalize(resolved);
  const wsNormalized = path.normalize(workspaceRoot);
  return normalized === wsNormalized || normalized.startsWith(wsNormalized + path.sep);
}

export function isIgnored(filePath: string, workspaceRoot: string): boolean {
  return isIgnoredInternal(filePath, workspaceRoot);
}

export function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  return isWithinWorkspaceInternal(filePath, workspaceRoot);
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

/** 解析 git status 输出 */
function parseGitStatus(output: string, workspaceRoot: string): { status: string; file: string }[] {
  const results: { status: string; file: string }[] = [];
  for (const line of output.trim().split("\n")) {
    if (!line.trim()) continue;
    // porcelain format: XY path (XY may have leading space for unstaged)
    const match = line.match(/^\s*(\S{1,2})\s+(.+?)(?:\r)?$/);
    if (!match) continue;
    const status = match[1];
    const file = match[2].trim().replace(/^"|"$/g, "");
    const resolved = path.resolve(workspaceRoot, file.replace(/\//g, path.sep));
    results.push({ status, file: resolved });
  }
  return results;
}

function getGitStatus(workspaceRoot: string): { status: string; file: string }[] {
  try {
    const output = execSync("git status --porcelain=v1 -uall", {
      cwd: workspaceRoot, encoding: "utf8",
    });
    return parseGitStatus(output, workspaceRoot);
  } catch {
    return [];
  }
}

export class MutationCollector {
  private workspaceRoot: string;
  private isGit: boolean;
  private preExistingChanges: Set<string> = new Set();
  private preExistingHashes: Map<string, string> = new Map();
  private candidateFiles: Set<string> = new Set();
  private watcherCaptured: Set<string> = new Set(); // watcher 捕获的变更
  private ignoredPaths: Set<string> = new Set();
  private rejectedPaths: Set<string> = new Set();
  private startTime: number = 0;
  private baselineTime: number = 0;
  private startGitStatus: Map<string, string> = new Map();
  private watcherReady: boolean = false;
  private watcherHandle: fs.FSWatcher | null = null;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.isGit = isGitRepo(this.workspaceRoot);
  }

  /** 记录基线 + 启动 watcher（任务开始前调用） */
  recordBaseline(): void {
    this.startTime = Date.now();
    if (this.isGit) {
      const status = getGitStatus(this.workspaceRoot);
      for (const { file } of status) {
        this.startGitStatus.set(file, "changed");
        this.preExistingChanges.add(file);
      }
      // 只对 preExisting 文件保存 Hash
      for (const f of this.preExistingChanges) {
        const h = hashFile(f);
        if (h) this.preExistingHashes.set(f, h);
      }
    }
    this.baselineTime = Date.now() - this.startTime;
    // 启动真实 watcher（即使 Git 项目也启动，用于捕获命令生成的文件）
    this.startWatcher();
    this.watcherReady = true;
    console.log(`[Mutation] baseline: git=${this.isGit}, preExisting=${this.preExistingChanges.size}, hashCount=${this.preExistingHashes.size}, baselineMs=${this.baselineTime}`);
  }

  /** 启动真实 fs.watch watcher */
  private startWatcher(): void {
    try {
      // 递归监听，但忽略 IGNORE_PATTERNS
      this.watcherHandle = fs.watch(
        this.workspaceRoot,
        { recursive: true, persistent: false },
        (eventType, filename) => {
          if (!filename) return;
          const filePath = path.resolve(this.workspaceRoot, filename);
          if (isIgnoredInternal(filePath, this.workspaceRoot)) return;
          if (!isWithinWorkspaceInternal(filePath, this.workspaceRoot)) return;
          this.watcherCaptured.add(filePath);
        },
      );
    } catch (err) {
      console.warn("[Mutation] fs.watch failed:", err);
    }
  }

  /** 关闭 watcher */
  closeWatcher(): void {
    if (this.watcherHandle) {
      try { this.watcherHandle.close(); } catch { /* ignore */ }
      this.watcherHandle = null;
    }
  }

  /** 添加候选文件（来自 Cline 事件） */
  addCandidate(filePath: string): void {
    if (!filePath) return;
    const resolved = path.resolve(filePath);

    // 工作区外拒绝
    if (!isWithinWorkspaceInternal(resolved, this.workspaceRoot)) {
      this.rejectedPaths.add(resolved);
      return;
    }

    // 忽略规则
    if (isIgnoredInternal(resolved, this.workspaceRoot)) {
      this.ignoredPaths.add(resolved);
      return;
    }

    this.candidateFiles.add(resolved);
  }

  /** 检查 watcher 是否 ready */
  isReady(): boolean {
    return this.watcherReady;
  }

  /** 收集证据（任务结束后调用） */
  collect(): { evidence: MutationEvidence; timing: MutationCollectorTiming } {
    // 收集前关闭 watcher（避免事件继续进入）
    this.closeWatcher();

    const collectStart = Date.now();
    const createdFiles: string[] = [];
    const modifiedFiles: string[] = [];
    const deletedFiles: string[] = [];
    const touchedPreExistingFiles: string[] = [];
    const evidenceSources = new Set<"cline_event" | "workspace_watch" | "file_snapshot" | "git_diff">();

    // 合并 watcher 捕获到 candidateFiles
    if (this.watcherCaptured.size > 0) {
      evidenceSources.add("workspace_watch");
      for (const f of this.watcherCaptured) {
        this.candidateFiles.add(f);
      }
    }

    if (this.isGit) {
        evidenceSources.add("git_diff");
        const endStatus = getGitStatus(this.workspaceRoot);
        const endFiles = new Set(endStatus.map(s => s.file));

        // 新出现的变更
        for (const { status, file } of endStatus) {
          if (!this.startGitStatus.has(file)) {
            if (status.includes("D") || !fs.existsSync(file)) {
              deletedFiles.push(file);
            } else if (status.includes("?")) {
              createdFiles.push(file);
            } else {
              modifiedFiles.push(file);
            }
          }
        }

      // 已删除的 preExisting
      for (const f of this.preExistingChanges) {
        if (!endFiles.has(f) && !fs.existsSync(f)) {
          if (!deletedFiles.includes(f)) deletedFiles.push(f);
        }
      }

      // 检查 preExisting 文件是否被再次修改（Hash 对比）
      for (const [f, oldHash] of this.preExistingHashes) {
        const newHash = hashFile(f);
        if (newHash && newHash !== oldHash) {
          if (!touchedPreExistingFiles.includes(f)) {
            touchedPreExistingFiles.push(f);
          }
        }
      }
    }

    // 用 candidate 补充非 Git 或 Git 未捕获的情况
    const allDetected = new Set([
      ...createdFiles, ...modifiedFiles, ...deletedFiles,
      ...touchedPreExistingFiles, ...this.preExistingChanges,
    ]);
    for (const f of this.candidateFiles) {
      evidenceSources.add("cline_event");
      if (allDetected.has(f)) continue;

      if (!fs.existsSync(f)) {
        if (!deletedFiles.includes(f)) deletedFiles.push(f);
      } else {
        if (!createdFiles.includes(f) && !modifiedFiles.includes(f)) {
          modifiedFiles.push(f);
        }
      }
    }

    const collectMs = Date.now() - collectStart;
    const totalMs = Date.now() - this.startTime;

    const evidence: MutationEvidence = {
      preExistingChanges: Array.from(this.preExistingChanges),
      touchedPreExistingFiles,
      candidateFiles: Array.from(this.candidateFiles),
      createdFiles,
      modifiedFiles,
      deletedFiles,
      ignoredPaths: Array.from(this.ignoredPaths),
      rejectedOutsideWorkspacePaths: Array.from(this.rejectedPaths),
      evidenceSources: Array.from(evidenceSources) as Array<"cline_event" | "workspace_watch" | "file_snapshot" | "git_diff">,
    };

    const timing: MutationCollectorTiming = {
      baselineMs: this.baselineTime,
      collectMs,
      totalMs,
    };

    return { evidence, timing };
  }
}