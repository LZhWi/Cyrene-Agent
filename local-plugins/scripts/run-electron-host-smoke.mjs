import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectLayout } from "./isolation-boundary.mjs";

const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(localRoot, "..");
const { projectContainerRoot, originalProjectRoot } = resolveProjectLayout(projectRoot);
const installedElectronPackage = [projectRoot, projectContainerRoot]
  .map((root) => path.join(root, "node_modules", "electron", "package.json"))
  .find(existsSync);
if (!installedElectronPackage) throw new Error("找不到当前项目的 Electron 版本信息");
const expectedVersion = JSON.parse(readFileSync(installedElectronPackage, "utf8")).version;
const candidates = [
  path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe"),
  path.join(projectContainerRoot, "node_modules", "electron", "dist", "electron.exe"),
  path.join(originalProjectRoot, "node_modules", "electron", "dist", "electron.exe"),
];

let executable;
for (const candidate of candidates) {
  if (!existsSync(candidate)) continue;
  const packagePath = path.resolve(candidate, "..", "..", "package.json");
  const version = JSON.parse(readFileSync(packagePath, "utf8")).version;
  if (version === expectedVersion) {
    executable = candidate;
    break;
  }
}
if (!executable) throw new Error(`找不到与当前项目匹配的 Electron ${expectedVersion}`);

const entry = path.join(localRoot, "scripts", "electron-host-smoke.cjs");
const userData = path.join(localRoot, ".test-runtime", "electron-host", "user-data");
const result = spawnSync(executable, [entry, `--user-data-dir=${userData}`], {
  cwd: projectRoot,
  stdio: "inherit",
  windowsHide: true,
  timeout: 45_000,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
