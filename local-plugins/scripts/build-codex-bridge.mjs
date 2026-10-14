import { build } from "esbuild";
import { zipSync } from "fflate";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateManifestData } from "@playa0v0/cyrene-plugin-sdk";
import { getArtifactRoot } from "./artifact-root.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "plugins", "codex-bridge");
const artifactRoot = await getArtifactRoot(root);
const destination = path.join(artifactRoot, "codex-bridge");
const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
const validation = validateManifestData(manifest);
if (!validation.ok) throw new Error(validation.error);
await mkdir(destination, { recursive: true });
await build({ entryPoints: [path.join(source, "src", "index.ts")], outfile: path.join(destination, "index.cjs"),
  bundle: true, format: "cjs", platform: "node", target: "node24", external: ["electron"], logLevel: "silent" });
for (const file of ["manifest.json", "README.md"]) await cp(path.join(source, file), path.join(destination, file));
for (const file of ["ui.html", "ui.js", "ui.css", "preload.cjs"]) await cp(path.join(source, "static", file), path.join(destination, file));
const entries = {};
for (const file of ["index.cjs", "manifest.json", "README.md", "ui.html", "ui.js", "ui.css", "preload.cjs"]) {
  entries[`codex-bridge/${file}`] = new Uint8Array(await readFile(path.join(destination, file)));
}
await writeFile(path.join(artifactRoot, "codex-bridge.zip"), zipSync(entries, { level: 9 }));
console.log(`Built ${path.join(artifactRoot, "codex-bridge.zip")}`);
