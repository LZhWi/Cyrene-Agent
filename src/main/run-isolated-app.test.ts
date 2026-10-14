import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
function fixture(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-launch-test-"));
  roots.push(root);
  const project = path.join(root, name);
  fs.mkdirSync(path.join(project, "scripts"), { recursive: true });
  fs.copyFileSync(path.resolve("scripts/run-isolated-app.mjs"), path.join(project, "scripts/run-isolated-app.mjs"));
  fs.mkdirSync(path.join(project, "scripts", "migration"));
  fs.copyFileSync(path.resolve("scripts/migration/startup-arguments.mjs"), path.join(project, "scripts/migration/startup-arguments.mjs"));
  const electron = path.join(project, "node_modules", "electron");
  fs.mkdirSync(path.join(electron, "dist"), { recursive: true });
  fs.writeFileSync(path.join(electron, "package.json"), "{}");
  fs.writeFileSync(path.join(electron, "dist", "electron.exe"), "");
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(project, "scripts/run-isolated-app.mjs"), ...args, "--preflight"], { encoding: "utf8" });
  return { root, project, run };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("cyrene-launch-test-")) throw new Error("Unsafe test cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("isolated startup", () => {
  it.each(["Cyrene-Agent-N", "Cyrene-Agent-N-life-conversation"])("launches %s only in its own temporary directories", (name) => {
    const { project, run } = fixture(name);
    const result = run("--temporary");
    expect(result.status, result.stderr).toBe(0);
    const preflight = JSON.parse(result.stdout);
    expect(preflight.mode).toBe("temporary");
    for (const value of Object.values(preflight.paths) as string[]) {
      expect(value.startsWith(path.join(project, ".runtime") + path.sep)).toBe(true);
      expect(fs.existsSync(value)).toBe(false);
    }
    expect(fs.existsSync(path.join(project, "AppData"))).toBe(false);
  });

  it("rejects the original Cyrene-Agent checkout before creating data", () => {
    const { project, run } = fixture("Cyrene-Agent");
    const result = run();
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(project, "AppData"))).toBe(false);
  });

  it("refuses nonempty unowned persistent data and preserves its contents", () => {
    const { project, run } = fixture("Cyrene-Agent-N-life-conversation");
    const userData = path.join(project, "AppData", "Roaming", "live2d-cyrene-n");
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, "memory.json"), "original");
    expect(run().status).not.toBe(0);
    expect(fs.readFileSync(path.join(userData, "memory.json"), "utf8")).toBe("original");
    expect(fs.existsSync(path.join(userData, ".cyrene-n-user-data.json"))).toBe(false);
  });

  it("rejects a redirected AppData directory", () => {
    const { root, project, run } = fixture("Cyrene-Agent-N-life-conversation");
    const other = path.join(root, "protected");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "sentinel"), "untouched");
    fs.symlinkSync(other, path.join(project, "AppData"), "junction");
    expect(run().status).not.toBe(0);
    expect(fs.readdirSync(other)).toEqual(["sentinel"]);
  });
});
