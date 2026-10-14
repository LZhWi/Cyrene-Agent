// Builds only this plugin; no shared plugin builder, package install or driver installation.
import { build } from "esbuild";
import { zipSync, unzipSync } from "fflate";
import { mkdir, readFile, writeFile, cp, realpath, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateManifestData } from "@playa0v0/cyrene-plugin-sdk";
import { getArtifactRoot } from "./artifact-root.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "plugins/dungeons-input");
const artifactRoot = await getArtifactRoot(root);
const output = path.join(artifactRoot, "dungeons-input");
await mkdir(output, { recursive: true });
if (await realpath(output) !== output) throw Error("Output must remain in this checkout");
const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
const checked = validateManifestData(manifest); if (!checked.ok) throw Error(checked.error);
await build({ entryPoints: [path.join(source, "src/index.ts")], outfile: path.join(output, "index.cjs"), bundle: true, platform: "node", format: "cjs", target: "node24" });
await cp(path.join(source, "manifest.json"), path.join(output, "manifest.json"));
await cp(path.join(source, "README.md"), path.join(output, "README.md"));
for (const name of ["settings.html", "settings.js"]) await cp(path.join(source, "static", name), path.join(output, name));
await mkdir(path.join(output, "runtime"), { recursive: true });
const vendor = path.join(source, "vendor");
const dll = await readFile(path.join(vendor, "ViGEmClient.dll"));
if (createHash("sha256").update(dll).digest("hex") !== "2bf0cb1d809039573c922737d298a1653d4dbc61408060ff45a9bcfde82e97d2") throw Error("Client DLL checksum mismatch");
await cp(path.join(vendor, "ViGEmClient.dll"), path.join(output, "runtime/ViGEmClient.dll"));
for (const name of ["ViGEmClient-LICENSE", "vgamepad-LICENSE", "dependency-provenance.json"]) await cp(path.join(vendor, name), path.join(output, name));
execFileSync(path.join(process.env.SystemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"), ["/nologo", "/target:exe", "/platform:x64", "/optimize+", "/codepage:65001", "/reference:System.Web.Extensions.dll", "/reference:System.Drawing.dll", `/out:${path.join(output, "runtime/DungeonsInput.exe")}`, path.join(source, "runtime/Controller.cs"), path.join(source, "runtime/Follow.cs")], { windowsHide: true, stdio: "pipe" });
console.log(execFileSync(path.join(output, "runtime/DungeonsInput.exe"), ["--self-test"], { windowsHide: true, encoding: "utf8" }).trim());
console.log(execFileSync(path.join(output, "runtime/DungeonsInput.exe"), ["--follow-self-test"], { windowsHide: true, encoding: "utf8" }).trim());
const entries = {};
async function files(dir, relative = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw Error("No symlinks in package");
    if (entry.isDirectory()) await files(path.join(dir, entry.name), name);
    else entries[`dungeons-input/${name.split(path.sep).join("/")}`] = new Uint8Array(await readFile(path.join(dir, entry.name)));
  }
}
await files(output);
const zip = zipSync(entries, { level: 9 }); const checkZip = unzipSync(zip);
for (const [name, data] of Object.entries(entries)) if (!Buffer.from(data).equals(Buffer.from(checkZip[name]))) throw Error(`ZIP mismatch: ${name}`);
const zipPath = path.join(artifactRoot, "dungeons-input.zip"); await writeFile(zipPath, zip);
console.log(JSON.stringify({ zip: zipPath, files: Object.keys(entries).length, bytes: zip.length, sha256: createHash("sha256").update(zip).digest("hex") }, null, 2));
