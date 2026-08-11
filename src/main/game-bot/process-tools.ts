import { execFile, spawn } from "child_process";
import * as path from "path";

/** 启动失败必须通过 Promise 返回，避免 ChildProcess 的 error 事件击穿 Electron 主进程。 */
export function launchDetached(exe: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(exe, [], { detached: true, shell: false, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function isProcessProbeRunning(output: string): boolean {
  return output.trim() === "RUNNING";
}

const processProbeCache = new Map<string, { checkedAt: number; running: boolean }>();
const PROCESS_PROBE_CACHE_MS = 2_000;

/** Windows 本地游戏进程探测；失败时安全地视为未运行。 */
export function isExecutableRunning(exe: string): Promise<boolean> {
  const imageName = path.basename(exe).trim();
  if (!imageName) return Promise.resolve(false);
  const processName = path.parse(imageName).name;
  const cacheKey = processName.toLowerCase();
  const cached = processProbeCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < PROCESS_PROBE_CACHE_MS) {
    return Promise.resolve(cached.running);
  }
  return new Promise<boolean>((resolve) => {
    const command = "$name=[Environment]::GetEnvironmentVariable('CYRENE_GAMEBOT_PROCESS_NAME'); if(Get-Process -Name $name -ErrorAction SilentlyContinue){'RUNNING'}";
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, CYRENE_GAMEBOT_PROCESS_NAME: processName },
    }, (error, stdout) => {
      const running = !error && isProcessProbeRunning(stdout);
      processProbeCache.set(cacheKey, { checkedAt: Date.now(), running });
      resolve(running);
    });
  });
}
