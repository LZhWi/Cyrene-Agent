import { mkdir, readFile, writeFile, realpath, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { zipSync, unzipSync } from "fflate";
import { validateManifestData } from "../../packages/plugin-sdk/dist/validate-manifest.js";
import { build } from "esbuild";
import { getArtifactRoot } from "./artifact-root.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const id = "cyrene-hud";
const files = ["manifest.json", "edition.cjs", "index.cjs", "collector.cjs", "settings.cjs", "motion.cjs", "metrics.js", "status.cjs", "notifications.cjs", "glass.cjs", "native/GlassHost.cs", "native/AsusSensors.cs", "preload.cjs", "hud.html", "hud.js", "settings.html", "settings.js", "style.css", "avatar.svg", "README.md", "NOTICE.md", "LICENSE"];
const source = path.join(root, "plugins", id);
const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
const checked = validateManifestData(manifest);
if (!checked.ok) throw Error(checked.error);
if (manifest.id !== id || manifest.defaultEnabled !== false || JSON.stringify(manifest.deps) !== '["window-navigation"]') throw Error("Unexpected plugin identity or services");
const artifactRoot = process.argv.includes("--release") ? path.join(root, "releases", `${id}-${manifest.version}`) : await getArtifactRoot(root);
const output = path.join(artifactRoot, id);
await mkdir(output, { recursive: true });
if (await realpath(output) !== output) throw Error("Output must remain in this checkout");
const framework = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319", metadata = "C:\\Windows\\System32\\WinMetadata";
const refs = ["System.Runtime", "System.Runtime.InteropServices.WindowsRuntime", "System.Runtime.WindowsRuntime", "System.Numerics", "System.Numerics.Vectors", "System.Drawing", "System.Windows.Forms"].map(name => "/r:" + path.join(framework, name + ".dll"));
refs.push(...(await readdir(metadata)).filter(name => name.endsWith(".winmd")).map(name => "/r:" + path.join(metadata, name)));
await promisify(execFile)(path.join(framework, "csc.exe"), ["/nologo", "/target:exe", "/platform:x64", "/out:" + path.join(output, "GlassHost.exe"), ...refs, path.join(source, "native", "GlassHost.cs")], { windowsHide: true });
const native = new Uint8Array(await readFile(path.join(output, "GlassHost.exe")));
await promisify(execFile)(path.join(framework, "csc.exe"), ["/nologo", "/target:exe", "/platform:x64", "/out:" + path.join(output, "AsusSensors.exe"), path.join(source, "native", "AsusSensors.cs")], { windowsHide: true });
const temperature = new Uint8Array(await readFile(path.join(output, "AsusSensors.exe")));
for (const edition of ["local", "upstream"]) {
  const editionOutput = edition === "local" ? output : path.join(artifactRoot, `${id}-upstream`);
  await mkdir(editionOutput, { recursive: true });
  if (await realpath(editionOutput) !== editionOutput) throw Error("Output must remain in this checkout");
  const entries = { [`${id}/GlassHost.exe`]: native, [`${id}/AsusSensors.exe`]: temperature };
  await writeFile(path.join(editionOutput, "GlassHost.exe"), native);
  await writeFile(path.join(editionOutput, "AsusSensors.exe"), temperature);
  const editionManifest = { ...manifest, name: `${manifest.name}（${edition === "local" ? "本地版" : "上游兼容版"}）`, deps: edition === "local" ? ["window-navigation"] : [] };
  if (!validateManifestData(editionManifest).ok) throw Error("Invalid edition manifest");
  for (const file of files) {
    let data = await readFile(path.join(source, file));
    if (file === "manifest.json") data = Buffer.from(JSON.stringify(editionManifest, null, 2) + "\n");
    if (file === "edition.cjs") data = Buffer.from(`"use strict";\nmodule.exports = "${edition}";\n`);
    if (file === "preload.cjs") {
      const bundled = await build({ stdin: { contents: data.toString().replace('const edition = "local";', `const edition = "${edition}";`), resolveDir: source, sourcefile: "preload.cjs" }, bundle: true, platform: "node", format: "cjs", target: "node24", external: ["electron"], write: false });
      data = Buffer.from(bundled.outputFiles[0].contents);
    }
    await mkdir(path.dirname(path.join(editionOutput, file)), { recursive: true });
    await writeFile(path.join(editionOutput, file), data);
    entries[`${id}/${file}`] = new Uint8Array(data);
  }
  const zip = zipSync(entries, { level: 9 }), unpacked = unzipSync(zip);
  for (const [name, data] of Object.entries(entries)) if (!Buffer.from(data).equals(Buffer.from(unpacked[name]))) throw Error(`ZIP mismatch: ${name}`);
  const zipPath = path.join(artifactRoot, `${id}-${edition}.zip`);
  await writeFile(zipPath, zip);
  if (edition === "local") await writeFile(path.join(artifactRoot, `${id}.zip`), zip);
  console.log(JSON.stringify({ edition, zip: zipPath, files: Object.keys(entries).length, bytes: zip.length, sha256: createHash("sha256").update(zip).digest("hex") }));
}
