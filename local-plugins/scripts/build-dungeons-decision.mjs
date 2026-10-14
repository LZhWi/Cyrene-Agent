// Dedicated build: never rebuilds dungeons-input or other plugins.
import { build } from "esbuild";
import { zipSync, unzipSync } from "fflate";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateManifestData } from "@playa0v0/cyrene-plugin-sdk";
import { getArtifactRoot } from "./artifact-root.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = await getArtifactRoot(root);
const source = path.join(root, "plugins/dungeons-decision"), output = path.join(artifactRoot, "dungeons-decision");
await mkdir(output, { recursive: true });
if (await realpath(output) !== output) throw Error("Output must remain in this checkout");
const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
const checked = validateManifestData(manifest); if (!checked.ok) throw Error(checked.error);
await build({ entryPoints: [path.join(source, "src/index.ts")], outfile: path.join(output, "index.cjs"), bundle: true, platform: "node", format: "cjs", target: "node24" });
const entries = {};
for (const [name, file] of Object.entries({ "manifest.json": "manifest.json", "README.md": "README.md", "settings.html": "static/settings.html", "settings.js": "static/settings.js" })) {
  const data = await readFile(path.join(source, file)); await writeFile(path.join(output, name), data); entries[`dungeons-decision/${name}`] = new Uint8Array(data);
}
entries["dungeons-decision/index.cjs"] = new Uint8Array(await readFile(path.join(output, "index.cjs")));
const zip = zipSync(entries, { level: 9 }), roundtrip = unzipSync(zip);
for (const [name, data] of Object.entries(entries)) if (!Buffer.from(data).equals(Buffer.from(roundtrip[name]))) throw Error(`ZIP mismatch: ${name}`);
const zipPath = path.join(artifactRoot, "dungeons-decision.zip"); await writeFile(zipPath, zip);
console.log(JSON.stringify({ zip: zipPath, files: Object.keys(entries).length, bytes: zip.length, sha256: createHash("sha256").update(zip).digest("hex") }, null, 2));
