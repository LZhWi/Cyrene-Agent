import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";
import minimatch from "minimatch";

const source = await readFile(new URL("../../electron-builder.yml", import.meta.url), "utf8");
const installerInclude = await readFile(new URL("../../build/installer/installer.nsh", import.meta.url), "utf8");
const config = load(source);

test("sharp native binaries and bundled libvips are unpacked", () => {
  for (const file of [
    "node_modules/sharp/build/Release/sharp-win32-x64.node",
    "node_modules/sharp/vendor/8.14.5/win32-x64/lib/libvips-42.dll",
  ]) {
    assert.ok(config.asarUnpack.some((pattern) => minimatch(file, pattern)), file);
  }
});

test("packaging excludes only the selected build artifacts and foreign ONNX platforms", () => {
  const excluded = (file) => config.files.some((pattern) =>
    typeof pattern === "string" && pattern.startsWith("!") && minimatch(file, pattern.slice(1)));
  for (const file of [
    "dist/perf-normal", "dist/perf-normal/main.js",
    "dist/perf-profiling/profile.json", "dist/renderer-old-backup/index.html",
    "dist/sim/main/sim.js", "dist/virtualization-test-build.log",
    "node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/libonnxruntime.dylib",
    "node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime.so",
    "node_modules/onnxruntime-node/bin/napi-v3/win32/arm64/onnxruntime.dll",
  ]) assert.ok(excluded(file), file);
  for (const file of [
    "dist/main/main/index.js", "dist/preload/index.js", "dist/renderer/react/index.html",
    "dist/renderer/learn-exam.html", "dist/renderer/assets/app.js.map",
    "node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime.dll",
  ]) assert.equal(excluded(file), false, file);
  assert.equal(config.win.electronLanguages, undefined);
});

test("the core package excludes optional model and music components", () => {
  assert.match(source, /-\s+"!dist\/components\/\*\*\/\*"/);
  assert.match(source, /-\s+"!models\/\*\*\/\*"/);
  assert.match(source, /-\s+"!vendor\/cloud-music-mcp\/\*\*\/\*"/);
  assert.doesNotMatch(source, /-\s+models\/\*\*\/\*/);
  assert.match(source, /-\s+from: resources\/components/);
  assert.match(source, /to: components/);
  assert.match(source, /artifactName:\s+Cyrene-Setup-\$\{version\}\.\$\{ext\}/);
});

test("the assisted installer exposes Cyrene setup choices and an uninstall entry", () => {
  assert.match(source, /createDesktopShortcut:\s+false/);
  assert.match(source, /include:\s+build\/installer\/installer\.nsh/);
  assert.match(source, /menuCategory:\s+Cyrene/);
});

test("the assisted installer stores launch preferences under the application package name", () => {
  assert.match(
    installerInclude,
    /\$APPDATA\\\$\{APP_PACKAGE_NAME\}\\installer-options\.json/,
  );
  assert.doesNotMatch(
    installerInclude,
    /\$APPDATA\\\$\{PRODUCT_FILENAME\}\\installer-options\.json/,
  );
});
