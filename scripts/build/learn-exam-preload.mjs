import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");

await build({
  entryPoints: [path.join(repoRoot, "src", "preload", "learn-exam-page.ts")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  external: ["electron"],
  outfile: path.join(repoRoot, "dist", "preload", "preload", "learn-exam-page.js"),
  logLevel: "info",
});

console.log("[preload] bundled learn-exam-page.js");
