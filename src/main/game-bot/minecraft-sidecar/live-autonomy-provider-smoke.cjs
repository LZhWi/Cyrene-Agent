"use strict";

const { readMinecraftSettings } = require("./live-provider-smoke.cjs");
const { chooseAutonomousTask } = require("./soul-orchestrator.cjs");

const settingsPath = process.argv[2];
if (!settingsPath) throw new Error("usage: node live-autonomy-provider-smoke.cjs <game-bot-settings.json>");

(async () => {
  const settings = readMinecraftSettings(settingsPath);
  settings.soul = { ...settings.soul, cacheSessionId: `smoke-${Date.now()}` };
  if (!settings.soul?.enabled) throw new Error("Minecraft Soul 尚未启用");
  const brief = await chooseAutonomousTask(settings.soul, {
    mode: "companion",
    allowedActions: ["status"],
    world: { health: 20, food: 20, dimension: "overworld", activeTask: null, nearbyEntities: [] },
    vision: { sceneSummary: "普通主世界地面，未发现危险", userActivity: "未知", hazards: [], confidence: 0.8 },
  }, {
    entryPersona: "昔涟会诚实观察，只选择小而安全的陪伴行动。",
    conversation: [], memories: [], gameConversation: [], gameSummary: "",
  }, settings.llm?.maxSteps || 4);
  process.stdout.write(`${JSON.stringify({ ok: true, result: brief ? "goal" : "idle", brief })}\n`);
})().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
