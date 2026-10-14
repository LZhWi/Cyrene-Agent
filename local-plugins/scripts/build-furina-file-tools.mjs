// Build only this plugin; preserve every other plugin artifact.
import { build } from "esbuild";
import { zipSync } from "fflate";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateManifestData } from "@playa0v0/cyrene-plugin-sdk";
import { getArtifactRoot } from "./artifact-root.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "plugins", "furina-file-tools");
const artifactRoot = await getArtifactRoot(root);
const destination = path.join(artifactRoot, "furina-file-tools");
const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
const validation = validateManifestData(manifest);
if (!validation.ok) throw new Error(validation.error);
await mkdir(destination, { recursive: true });
await build({ entryPoints: [path.join(source, "src", "index.ts")], outfile: path.join(destination, "index.cjs"),
  bundle: true, format: "cjs", platform: "node", target: "node24", external: ["electron"], logLevel: "silent" });
for (const file of ["manifest.json", "README.md"]) await cp(path.join(source, file), path.join(destination, file));
const staticFiles = ["settings.html", "settings.js", "preload.cjs", "ui.html", "ui.css", "ui.js"];
for (const file of staticFiles) await cp(path.join(source, "static", file), path.join(destination, file));
const entries = {};
for (const file of ["index.cjs", "manifest.json", "README.md", ...staticFiles]) {
  entries[`furina-file-tools/${file}`] = new Uint8Array(await readFile(path.join(destination, file)));
}
await writeFile(path.join(artifactRoot, "furina-file-tools.zip"), zipSync(entries, { level: 9 }));
console.log(`Built ${path.join(artifactRoot, "furina-file-tools.zip")}`);
