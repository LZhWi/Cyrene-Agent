import assert from "node:assert/strict";
import { test } from "node:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { buildPlugins } from "./build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const parent = path.join(await realpath(root), ".test-runtime");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "build-regression-"));
  t.after(async () => {
    assert.equal(path.dirname(directory), parent);
    assert.equal(await realpath(directory), directory);
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, "plugins"));
  await mkdir(path.join(directory, "scripts"));
  await mkdir(path.join(directory, "artifacts"));
  return directory;
}

async function plugin(directory, id, entry = "module.exports = { register() {} };") {
  const source = path.join(directory, "plugins", id);
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, "src", "index.ts"), entry);
  await writeFile(path.join(source, "README.md"), id);
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({
    apiVersion: 1, id, name: id, version: "0.1.0", description: "Build regression fixture",
    author: "test", entry: "index.cjs", defaultEnabled: false, deps: ["window-navigation"],
  }));
}

async function oldArtifact(directory, id) {
  await mkdir(path.join(directory, "artifacts", id));
  await writeFile(path.join(directory, "artifacts", id, "stale.txt"), "old output");
  await writeFile(path.join(directory, "artifacts", `${id}.zip`), "old zip");
}

async function snapshot(directory) {
  const entries = {};
  async function visit(current, relative = "") {
    for (const name of (await readdir(current)).sort()) {
      const absolute = path.join(current, name), key = path.join(relative, name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) entries[key] = await readlink(absolute);
      else if (stat.isDirectory()) { entries[key] = "directory"; await visit(absolute, key); }
      else entries[key] = createHash("sha256").update(await readFile(absolute)).digest("hex");
    }
  }
  await visit(path.join(directory, "artifacts"));
  return entries;
}

test("late bundle failure preserves every existing artifact and removes temporary output", async (t) => {
  const directory = await fixture(t);
  await plugin(directory, "a-valid");
  await plugin(directory, "z-broken", 'import "./missing-file";');
  await oldArtifact(directory, "a-valid");
  await oldArtifact(directory, "z-broken");
  await oldArtifact(directory, "unrelated");
  const before = await snapshot(directory);
  await assert.rejects(buildPlugins({ root: directory }), /missing-file/);
  assert.deepEqual(await snapshot(directory), before);
});

test("successful build replaces its own output, removes stale files and preserves unrelated packages", async (t) => {
  const directory = await fixture(t);
  await plugin(directory, "example");
  await oldArtifact(directory, "example");
  await oldArtifact(directory, "unrelated");
  const before = await snapshot(directory);
  await buildPlugins({ root: directory });
  assert.deepEqual((await readdir(path.join(directory, "artifacts"))).sort(), ["example", "example.zip", "unrelated", "unrelated.zip"]);
  assert.deepEqual((await readdir(path.join(directory, "artifacts", "example"))).sort(), ["README.md", "index.cjs", "manifest.json"]);
  const archive = unzipSync(await readFile(path.join(directory, "artifacts", "example.zip")));
  for (const [name, data] of Object.entries(archive)) {
    assert.deepEqual(Buffer.from(data), await readFile(path.join(directory, "artifacts", name)));
  }
  assert.deepEqual(JSON.parse(Buffer.from(archive["example/manifest.json"]).toString()).deps, ["window-navigation"]);
  const after = await snapshot(directory);
  for (const key of Object.keys(before).filter((key) => key.startsWith("unrelated"))) assert.equal(after[key], before[key]);
});

test("dedicated build failure leaves all old packages intact", async (t) => {
  const directory = await fixture(t);
  await plugin(directory, "a-valid");
  await mkdir(path.join(directory, "plugins", "cyrene-hud"));
  await oldArtifact(directory, "a-valid");
  await oldArtifact(directory, "cyrene-hud");
  await writeFile(path.join(directory, "scripts", "build-cyrene-hud.mjs"), `
    import { writeFile } from "node:fs/promises";
    import path from "node:path";
    await writeFile(path.join(process.env.CYRENE_PLUGIN_ARTIFACTS_ROOT, "cyrene-hud.zip"), "partial");
    throw new Error("native compile failure fixture");
  `);
  const before = await snapshot(directory);
  await assert.rejects(buildPlugins({ root: directory }));
  assert.deepEqual(await snapshot(directory), before);
});

test("dedicated builders use staging, publish HUD editions and receive explicit Minecraft dependencies", async (t) => {
  const directory = await fixture(t);
  for (const id of ["cyrene-hud", "minecraft-body"]) {
    await mkdir(path.join(directory, "plugins", id));
    await writeFile(path.join(directory, "scripts", `build-${id}.mjs`), `
      import { mkdir, writeFile } from "node:fs/promises";
      import path from "node:path";
      import assert from "node:assert/strict";
      const staged = process.env.CYRENE_PLUGIN_ARTIFACTS_ROOT;
      assert.equal(path.dirname(staged), path.join(process.cwd(), "artifacts"));
      assert.match(path.basename(staged), /^\\.build-/);
      if (${JSON.stringify(id)} === "minecraft-body") assert.deepEqual(process.argv.slice(2), ["--dependency-source", process.cwd()]);
      for (const name of ${JSON.stringify(id === "cyrene-hud" ? [id, `${id}-upstream`] : [id])}) {
        await mkdir(path.join(staged, name));
        await writeFile(path.join(staged, name, "index.cjs"), "built");
        await writeFile(path.join(staged, name + ".zip"), "built zip");
      }
      if (${JSON.stringify(id)} === "cyrene-hud") await writeFile(path.join(staged, "cyrene-hud-local.zip"), "local edition");
    `);
  }
  await buildPlugins({ root: directory, dependencySource: directory });
  assert.deepEqual((await readdir(path.join(directory, "artifacts"))).sort(), [
    "cyrene-hud", "cyrene-hud-local.zip", "cyrene-hud-upstream", "cyrene-hud-upstream.zip", "cyrene-hud.zip", "minecraft-body", "minecraft-body.zip",
  ]);
});

test("linked replacement targets are rejected before touching old packages", async (t) => {
  const directory = await fixture(t);
  await plugin(directory, "a-valid");
  await plugin(directory, "z-linked");
  await oldArtifact(directory, "a-valid");
  const outside = path.join(directory, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "keep.txt"), "outside remains untouched");
  await symlink(outside, path.join(directory, "artifacts", "z-linked"), "junction");
  const before = await snapshot(directory);
  await assert.rejects(buildPlugins({ root: directory }), /目标不能是链接/);
  assert.deepEqual(await snapshot(directory), before);
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "outside remains untouched");
});
