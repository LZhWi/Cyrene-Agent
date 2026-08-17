"use strict";

const fs = require("node:fs");

const file = process.argv[2];
if (!file) throw new Error("usage: node set-verified-executor-config.cjs <game-bot-settings.json>");
const source = fs.readFileSync(file, "utf8");
const settings = JSON.parse(source);
if (!settings.minecraft?.llm || settings.minecraft.llm.model !== "glm-4.7") {
  throw new Error("GameBot executor model is not glm-4.7; refusing to change settings");
}
settings.minecraft.llm.reasoning = "off";
if (process.argv[3] === "enable") {
  settings.minecraft.username = "CyreneTest";
  settings.minecraft.owner = "ColdAsIceeeee";
  settings.minecraft.auth = "offline";
  settings.minecraft.llm.enabled = true;
  settings.minecraft.soul.enabled = true;
}
const temporary = `${file}.codex-minecraft.tmp`;
fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), "utf8");
fs.renameSync(temporary, file);
process.stdout.write(`${JSON.stringify({
  ok: true,
  username: settings.minecraft.username,
  owner: settings.minecraft.owner,
  auth: settings.minecraft.auth,
  executor: { enabled: settings.minecraft.llm.enabled, model: settings.minecraft.llm.model, reasoning: settings.minecraft.llm.reasoning },
  soul: { enabled: settings.minecraft.soul.enabled, model: settings.minecraft.soul.model, reasoning: settings.minecraft.soul.reasoning },
})}\n`);
