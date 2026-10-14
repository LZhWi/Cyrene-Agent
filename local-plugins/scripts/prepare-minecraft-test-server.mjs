// Downloads only into this project's ignored MC test assets directory.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, ".test-runtime", "minecraft-server-assets");
const targetVersion = process.argv[2] || "1.21.11";
if (!["1.21.4", "1.21.11"].includes(targetVersion)) throw new Error("测试服版本只允许 1.21.4 或 1.21.11");
await mkdir(assets, { recursive: true });
const json = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return response.json();
};
async function download(url, file, algorithm, expected) {
  try {
    const current = await readFile(file);
    if (createHash(algorithm).update(current).digest("hex") === expected) return;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash(algorithm).update(bytes).digest("hex") !== expected) throw new Error(`下载哈希不匹配：${file}`);
  await writeFile(file + ".tmp", bytes);
  await rename(file + ".tmp", file);
}
const manifest = await json("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
const version = manifest.versions.find((version) => version.id === targetVersion);
const metadata = await json(version.url);
const java = (await json("https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&heap_size=normal&image_type=jre&jvm_impl=hotspot&os=windows&vendor=eclipse"))[0].binary.package;
await download(metadata.downloads.server.url, path.join(assets, `server-${targetVersion}.jar`), "sha1", metadata.downloads.server.sha1);
await download(java.link, path.join(assets, "java21.zip"), "sha256", java.checksum);
await writeFile(path.join(assets, `downloads-${targetVersion}.json`), JSON.stringify({ server: metadata.downloads.server, java }, null, 2));
console.log(JSON.stringify({ assets, serverSha1: metadata.downloads.server.sha1, javaSha256: java.checksum }));
