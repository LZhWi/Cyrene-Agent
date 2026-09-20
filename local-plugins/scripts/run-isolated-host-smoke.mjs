import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [cli, "run", "--config", "vitest.config.mjs", "tests/isolated-host.test.ts", "--maxWorkers=1"], {
  cwd: root,
  env: { ...process.env, CYRENE_ISOLATED_HOST_SMOKE: "1" },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
