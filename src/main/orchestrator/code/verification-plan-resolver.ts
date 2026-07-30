/**
 * VerificationPlanResolver - 验证计划解析器
 *
 * 解析优先级：
 * 1. 项目显式配置 .cyrene-verify.json
 * 2. package.json scripts
 * 3. 变更文件所属的最近 package 边界
 * 4. tsconfig / Vitest / Jest 配置
 * 5. 可以证明安全的 builtin fallback
 *
 * 禁止：
 * - 发现 .ts 文件就直接在 workspaceRoot 跑 typecheck
 * - 静默降级到猜测命令
 * - 拼接 Shell 字符串
 *
 * 找不到可信计划时返回 VERIFICATION_PLAN_NOT_FOUND。
 */

import * as fs from "fs";
import * as path from "path";

// ── 类型 ──────────────────────────────────────────────────

export type VerificationType = "typecheck" | "test" | "lint" | "build";

export type VerificationCommandTrust = "builtin" | "workspace_script" | "custom";

export type VerificationSource =
  | "cyrene_config"
  | "package_script"
  | "tsconfig"
  | "vitest"
  | "jest"
  | "builtin_fallback";

export interface VerificationStep {
  id: string;
  type: VerificationType;
  packageRoot: string;
  cwd: string;
  configPath?: string;

  trust: VerificationCommandTrust;
  executable: string;
  args: string[];

  source: VerificationSource;
}

export interface VerificationPlan {
  workspaceRoot: string;
  affectedPackages: string[];
  steps: VerificationStep[];
  errorCode?: "VERIFICATION_PLAN_NOT_FOUND" | "VERIFICATION_CONFIG_INVALID";
  diagnostics: string[];
}

export interface CyreneVerificationConfig {
  steps: Array<{
    type: VerificationType;
    cwd?: string;
    executable: string;
    args?: string[];
  }>;
}

// ── 输入 ──────────────────────────────────────────────────

export interface ResolverInput {
  workspaceRoot: string;
  createdFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  touchedPreExistingFiles: string[];
}

// ── 工具函数 ──────────────────────────────────────────────

function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  const resolved = path.resolve(filePath);
  const normalized = path.normalize(resolved);
  const wsNormalized = path.normalize(workspaceRoot);
  return normalized === wsNormalized || normalized.startsWith(wsNormalized + path.sep);
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/** 向上查找最近的 package.json */
function findNearestPackageJson(filePath: string, workspaceRoot: string): string | null {
  let dir = path.dirname(filePath);
  while (dir.startsWith(workspaceRoot) || dir === workspaceRoot) {
    const candidate = path.join(dir, "package.json");
    if (fileExists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 检测包管理器 */
function detectPackageManager(workspaceRoot: string): { executable: string; args: string[] } {
  if (fileExists(path.join(workspaceRoot, "pnpm-lock.yaml"))) {
    return { executable: "pnpm", args: [] };
  }
  if (fileExists(path.join(workspaceRoot, "yarn.lock"))) {
    return { executable: "yarn", args: [] };
  }
  return { executable: "npm", args: [] };
}

/** 解析 .cyrene-verify.json，文件存在但解析失败返回特殊标记 */
function parseCyreneConfig(workspaceRoot: string): { config: CyreneVerificationConfig | null; invalid: boolean } {
  const configPath = path.join(workspaceRoot, ".cyrene-verify.json");
  if (!fileExists(configPath)) return { config: null, invalid: false };
  const parsed = readJsonSafe<CyreneVerificationConfig>(configPath);
  if (parsed === null) return { config: null, invalid: true };
  return { config: parsed, invalid: false };
}

/** 解析 package.json scripts */
interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

const TEST_SCRIPT_NAMES = ["test", "test:unit", "vitest", "jest", "test:run"];
const TYPECHECK_SCRIPT_NAMES = ["typecheck", "tsc", "check-types", "type-check"];

function parsePackageScripts(pkgPath: string): {
  typecheck: { name: string; command: string } | null;
  test: { name: string; command: string } | null;
} {
  const pkg = readJsonSafe<PackageJson>(pkgPath);
  if (!pkg?.scripts) return { typecheck: null, test: null };

  let typecheck: { name: string; command: string } | null = null;
  for (const name of TYPECHECK_SCRIPT_NAMES) {
    if (pkg.scripts[name]) {
      typecheck = { name, command: pkg.scripts[name] };
      break;
    }
  }

  let test: { name: string; command: string } | null = null;
  for (const name of TEST_SCRIPT_NAMES) {
    if (pkg.scripts[name]) {
      test = { name, command: pkg.scripts[name] };
      break;
    }
  }

  return { typecheck, test };
}

function findTsconfig(startDir: string, workspaceRoot: string): string | null {
  let dir = startDir;
  while (dir.startsWith(workspaceRoot) || dir === workspaceRoot) {
    for (const name of ["tsconfig.json", "tsconfig.build.json", "tsconfig.main.json"]) {
      const candidate = path.join(dir, name);
      if (fileExists(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findTestConfig(startDir: string, workspaceRoot: string): {
  type: "vitest" | "jest";
  path: string;
} | null {
  let dir = startDir;
  while (dir.startsWith(workspaceRoot) || dir === workspaceRoot) {
    for (const name of ["vitest.config.ts", "vitest.config.js", "vitest.config.mts", "jest.config.ts", "jest.config.js"]) {
      const candidate = path.join(dir, name);
      if (fileExists(candidate)) {
        if (name.startsWith("vitest")) return { type: "vitest", path: candidate };
        return { type: "jest", path: candidate };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 检查项目是否本地依赖 typescript */
function hasLocalTypeScript(packageJsonPath: string): boolean {
  const pkg = readJsonSafe<PackageJson>(packageJsonPath);
  if (!pkg) return false;
  return Boolean(pkg.dependencies?.typescript || pkg.devDependencies?.typescript);
}

// ── 收集真实变更涉及的 package ────────────────────────────

function collectAffectedPackages(input: ResolverInput): Map<string, string> {
  // packageRoot -> package.json path
  const pkgs = new Map<string, string>();
  const allFiles = [
    ...input.createdFiles,
    ...input.modifiedFiles,
    ...input.touchedPreExistingFiles,
  ];
  for (const f of allFiles) {
    if (!isWithinWorkspace(f, input.workspaceRoot)) continue;
    const pkgPath = findNearestPackageJson(f, input.workspaceRoot);
    if (pkgPath) {
      pkgs.set(path.dirname(pkgPath), pkgPath);
    }
  }
  return pkgs;
}

// ── 解析器主类 ────────────────────────────────────────────

export class VerificationPlanResolver {
  resolve(input: ResolverInput): VerificationPlan {
    const diagnostics: string[] = [];
    const affectedPackages = collectAffectedPackages(input);

    // 1. 检查显式配置
    const cyreneResult = parseCyreneConfig(input.workspaceRoot);
    if (cyreneResult.invalid) {
      return {
        workspaceRoot: input.workspaceRoot,
        affectedPackages: Array.from(affectedPackages.keys()),
        steps: [],
        errorCode: "VERIFICATION_CONFIG_INVALID",
        diagnostics: [".cyrene-verify.json 解析失败"],
      };
    }
    if (cyreneResult.config) {
      const configValidation = this.validateCyreneConfig(cyreneResult.config, input.workspaceRoot);
      if (configValidation.errorCode === "VERIFICATION_CONFIG_INVALID") {
        return {
          workspaceRoot: input.workspaceRoot,
          affectedPackages: Array.from(affectedPackages.keys()),
          steps: [],
          errorCode: "VERIFICATION_CONFIG_INVALID",
          diagnostics: configValidation.diagnostics,
        };
      }
      return {
        workspaceRoot: input.workspaceRoot,
        affectedPackages: Array.from(affectedPackages.keys()),
        steps: configValidation.steps,
        diagnostics: configValidation.diagnostics,
      };
    }

    // 2. 从 package.json scripts 解析
    if (affectedPackages.size === 0) {
      return {
        workspaceRoot: input.workspaceRoot,
        affectedPackages: [],
        steps: [],
        errorCode: "VERIFICATION_PLAN_NOT_FOUND",
        diagnostics: ["无受影响的 package"],
      };
    }

    const steps: VerificationStep[] = [];
    const seenSteps = new Set<string>();
    const pm = detectPackageManager(input.workspaceRoot);

    for (const [pkgRoot, pkgJsonPath] of affectedPackages) {
      const scripts = parsePackageScripts(pkgJsonPath);

      // typecheck
      if (scripts.typecheck) {
        const key = `typecheck:${pkgRoot}`;
        if (!seenSteps.has(key)) {
          seenSteps.add(key);
          steps.push({
            id: `typecheck-${steps.length}`,
            type: "typecheck",
            packageRoot: pkgRoot,
            cwd: pkgRoot,
            trust: "workspace_script",
            executable: pm.executable,
            args: [...pm.args, "run", scripts.typecheck.name],
            source: "package_script",
          });
        }
      }

      // test
      if (scripts.test) {
        const key = `test:${pkgRoot}`;
        if (!seenSteps.has(key)) {
          seenSteps.add(key);
          steps.push({
            id: `test-${steps.length}`,
            type: "test",
            packageRoot: pkgRoot,
            cwd: pkgRoot,
            trust: "workspace_script",
            executable: pm.executable,
            args: [...pm.args, "run", scripts.test.name],
            source: "package_script",
          });
        }
      }

      // 3. 尝试 tsconfig builtin fallback
      if (!scripts.typecheck) {
        const tsconfigPath = findTsconfig(pkgRoot, input.workspaceRoot);
        if (tsconfigPath && hasLocalTypeScript(pkgJsonPath)) {
          const key = `typecheck:${pkgRoot}`;
          if (!seenSteps.has(key)) {
            seenSteps.add(key);
            diagnostics.push(`使用 tsconfig builtin fallback: ${tsconfigPath}`);
            steps.push({
              id: `typecheck-${steps.length}`,
              type: "typecheck",
              packageRoot: pkgRoot,
              cwd: pkgRoot,
              trust: "builtin",
              executable: "builtin:tsc", // VerificationRunner 会解析为本地 tsc
              args: ["--noEmit", "--project", tsconfigPath],
              configPath: tsconfigPath,
              source: "tsconfig",
            });
          }
        }
      }

      // 4. 测试框架 builtin fallback
      if (!scripts.test) {
        const testConfig = findTestConfig(pkgRoot, input.workspaceRoot);
        if (testConfig) {
          const key = `test:${pkgRoot}`;
          if (!seenSteps.has(key)) {
            seenSteps.add(key);
            diagnostics.push(`使用 ${testConfig.type} 配置: ${testConfig.path}`);
            steps.push({
              id: `test-${steps.length}`,
              type: "test",
              packageRoot: pkgRoot,
              cwd: pkgRoot,
              trust: "builtin",
              executable: testConfig.type === "vitest" ? "builtin:vitest" : "builtin:jest",
              args: ["run"],
              configPath: testConfig.path,
              source: testConfig.type,
            });
          }
        }
      }
    }

    if (steps.length === 0) {
      return {
        workspaceRoot: input.workspaceRoot,
        affectedPackages: Array.from(affectedPackages.keys()),
        steps: [],
        errorCode: "VERIFICATION_PLAN_NOT_FOUND",
        diagnostics: [...diagnostics, "无任何验证步骤可生成"],
      };
    }

    return {
      workspaceRoot: input.workspaceRoot,
      affectedPackages: Array.from(affectedPackages.keys()),
      steps,
      diagnostics,
    };
  }

  /** 验证 .cyrene-verify.json 配置 */
  private validateCyreneConfig(
    config: CyreneVerificationConfig,
    workspaceRoot: string,
  ): { steps: VerificationStep[]; diagnostics: string[]; errorCode?: "VERIFICATION_CONFIG_INVALID" } {
    const diagnostics: string[] = [];
    const steps: VerificationStep[] = [];

    if (!Array.isArray(config.steps)) {
      return {
        steps: [],
        diagnostics: ["config.steps 不是数组"],
        errorCode: "VERIFICATION_CONFIG_INVALID",
      };
    }

    for (let i = 0; i < config.steps.length; i++) {
      const step = config.steps[i];
      if (!step.executable) {
        return {
          steps: [],
          diagnostics: [`step[${i}].executable 缺失`],
          errorCode: "VERIFICATION_CONFIG_INVALID",
        };
      }
      if (!step.type) {
        return {
          steps: [],
          diagnostics: [`step[${i}].type 缺失`],
          errorCode: "VERIFICATION_CONFIG_INVALID",
        };
      }
      const cwd = step.cwd ? path.resolve(workspaceRoot, step.cwd) : workspaceRoot;
      if (!isWithinWorkspace(cwd, workspaceRoot)) {
        return {
          steps: [],
          diagnostics: [`step[${i}].cwd 越界: ${cwd}`],
          errorCode: "VERIFICATION_CONFIG_INVALID",
        };
      }
      steps.push({
        id: `cyrene-${i}`,
        type: step.type,
        packageRoot: cwd,
        cwd,
        trust: "custom", // 配置中的命令默认为 custom
        executable: step.executable,
        args: step.args ?? [],
        source: "cyrene_config",
      });
    }

    return { steps, diagnostics };
  }
}