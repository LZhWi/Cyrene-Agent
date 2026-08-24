import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { writeJsonAtomicSync } = require("../dist/main/main/runtime/atomic-file.js");
const { appendRotatingLogSync } = require("../dist/main/main/runtime/rotating-log.js");
const { SettingsFacade, normalizeGeneralSettings } = require("../dist/main/main/settings/settings-facade.js");
const userData = join(process.env.APPDATA ?? "", "live2d-cyrene");
const candidates = [
  "model-settings.json",
  "app-settings.json",
  "user-profile.json",
  "mcp-servers.json",
  "channels-settings.json",
  "permission-settings.json",
  "location-cache.json",
  "sticker-settings.json",
  "sticker-manifest.json",
].map((name) => join(userData, name)).filter(existsSync);

const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const isolated = await mkdtemp(join(tmpdir(), "cyrene-config-persistence-"));
const results = [];
try {
  for (const source of candidates) {
    const before = await readFile(source);
    const parsed = JSON.parse(before.toString("utf8"));
    const copy = join(isolated, basename(source));
    await copyFile(source, copy);
    writeJsonAtomicSync(copy, parsed);
    const rewritten = JSON.parse(await readFile(copy, "utf8"));
    const sourceAfter = await readFile(source);
    if (JSON.stringify(rewritten) !== JSON.stringify(parsed)) {
      throw new Error(`semantic mismatch: ${basename(source)}`);
    }
    if (hash(sourceAfter) !== hash(before)) {
      throw new Error(`source changed: ${basename(source)}`);
    }
    results.push({ file: basename(source), semanticMatch: true, sourceUnchanged: true });
  }
  const generalSettingsSource = join(userData, "app-settings.json");
  let generalSettingsFacade = null;
  if (existsSync(generalSettingsSource)) {
    const sourceBefore = await readFile(generalSettingsSource);
    const sourceParsed = JSON.parse(sourceBefore.toString("utf8"));
    const isolatedSettingsPath = join(isolated, "app-settings.json");
    const expected = normalizeGeneralSettings(sourceParsed);
    const facade = new SettingsFacade(() => isolatedSettingsPath);
    let notification = null;
    facade.onChanged((before, after) => {
      notification = {
        beforeMatches: JSON.stringify(before) === JSON.stringify(expected),
        afterMatches: JSON.stringify(after) === JSON.stringify(expected),
      };
    });
    const loaded = facade.load();
    const saved = facade.save({});
    const reloaded = facade.load();
    const sourceAfter = await readFile(generalSettingsSource);
    generalSettingsFacade = {
      loadMatchesNormalized: JSON.stringify(loaded) === JSON.stringify(expected),
      saveMatchesNormalized: JSON.stringify(saved) === JSON.stringify(expected),
      reloadMatchesNormalized: JSON.stringify(reloaded) === JSON.stringify(expected),
      notification,
      sourceUnchanged: hash(sourceAfter) === hash(sourceBefore),
    };
    if (
      !generalSettingsFacade.loadMatchesNormalized
      || !generalSettingsFacade.saveMatchesNormalized
      || !generalSettingsFacade.reloadMatchesNormalized
      || !notification?.beforeMatches
      || !notification?.afterMatches
      || !generalSettingsFacade.sourceUnchanged
    ) {
      throw new Error(`settings facade mismatch: ${JSON.stringify(generalSettingsFacade)}`);
    }
  }
  const chatLog = join(userData, "chat-api.log");
  let logRotation = null;
  if (existsSync(chatLog)) {
    const before = await readFile(chatLog);
    const copy = join(isolated, "chat-api.log");
    await copyFile(chatLog, copy);
    appendRotatingLogSync(copy, "persistence-smoke\n", before.length);
    const backup = await readFile(`${copy}.1`);
    const sourceAfter = await readFile(chatLog);
    logRotation = {
      backupMatches: hash(backup) === hash(before),
      sourceUnchanged: hash(sourceAfter) === hash(before),
    };
    if (!logRotation.backupMatches || !logRotation.sourceUnchanged) {
      throw new Error("isolated log rotation mismatch");
    }
  }
  console.log(JSON.stringify({ ok: true, checked: results.length, results, generalSettingsFacade, logRotation }, null, 2));
} finally {
  await rm(isolated, { recursive: true, force: true });
}
