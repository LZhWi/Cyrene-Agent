"use strict";
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { MinecraftBody } = require("./body.cjs");

let bot;
let body;
let heartbeat;
let started = false;
let closing = false;
const session = {};
const send = (message) => { if (process.connected) process.send(message); };
const errorText = (error) => error instanceof Error ? error.message : String(error);

function close() {
  if (closing) return;
  closing = true;
  clearInterval(heartbeat);
  body?.disconnect("身体进程关闭");
  try { bot?.quit(); } catch {}
  // Microsoft login or a stalled network socket must not keep a disabled plugin alive.
  setTimeout(() => process.exit(0), 500).unref();
  if (!bot) process.exit(0);
}

process.on("message", async (message) => {
  if (!message || closing) return;
  try {
    if (message.type === "start") {
      if (started) throw new Error("身体进程只能启动一次");
      started = true;
      const { host, port, username, auth, version, owner } = message.config;
      bot = mineflayer.createBot({ host, port, username, auth, version: version || false,
        profilesFolder: message.profilesFolder,
        onMsaCode: (code) => send({ type: "login", data: { url: code.verification_uri, code: code.user_code } }),
      });
      bot.loadPlugin(pathfinder);
      // 1.21.11 can report waking through pose metadata without the legacy
      // wake animation. Keep Mineflayer's flag aligned with server metadata.
      bot.on("entityUpdate", (entity) => {
        if (entity !== bot.entity) return;
        const index = bot.registry?.entitiesByName?.player?.metadataKeys?.indexOf("pose");
        const pose = index >= 0 ? entity.metadata?.[index] : undefined;
        if (Number.isInteger(pose)) bot.isSleeping = pose === 2;
      });
      bot.on("spawn", () => {
        body?.disconnect("角色重新出生");
        body = new MinecraftBody(bot, { goals, Movements, owner, session, autoSurvival: message.config.autoSurvival === true, onResult: (data) => send({ type: "result", data }) });
        send({ type: "state", data: body.snapshot() });
      });
      bot.on("health", () => body?.reflex());
      bot.on("physicsTick", () => body?.reflex());
      bot.on("death", () => body?.disconnect("角色死亡，动作不会自动恢复"));
      // Observation only. Neither owner chat nor public chat is an execution entry.
      bot.on("chat", (username, text) => send({ type: "chat", data: { username, text: String(text).slice(0, 2000) } }));
      bot.on("kicked", (reason) => send({ type: "notice", data: `被服务器踢出：${String(reason).slice(0, 2000)}` }));
      bot.on("error", (error) => send({ type: "notice", data: errorText(error) }));
      bot.once("end", (reason) => {
        body?.disconnect(`连接断开：${reason}`);
        clearInterval(heartbeat);
        send({ type: "ended", data: String(reason) });
        // No reconnect/replay. A new connection requires an explicit panel action.
        process.exitCode = 0;
        close();
      });
      heartbeat = setInterval(() => { if (body) send({ type: "state", data: body.snapshot() }); }, 500);
    } else if (message.type === "task-control") {
      try {
        if (!body) throw new Error("身体未出生");
        let value;
        if (message.op === "acquire") value = body.acquireTask(message.taskId, message.region);
        else if (message.op === "release") value = body.releaseTask(message.taskId);
        else if (message.op === "observe") value = body.observeTask(message.region);
        else throw new Error("未知任务操作");
        send({ type: "task-reply", id: message.id, data: { value: await value } });
      } catch (error) { send({ type: "task-reply", id: message.id, data: { error: errorText(error) } }); }
    } else if (message.type === "action") {
      if (!body) throw new Error("等待机器人出生后再执行动作");
      // execute emits active and terminal results; catch only rejected requests.
      await body.execute(message.request);
    } else if (message.type === "cancel") {
      body?.cancel();
    } else if (message.type === "stop") {
      close();
    } else {
      throw new Error("未知身体请求");
    }
  } catch (error) {
    send({ type: "rejected", id: message.request?.id, data: errorText(error) });
  }
});
process.on("disconnect", close);
process.on("SIGTERM", close);
process.on("SIGINT", close);
