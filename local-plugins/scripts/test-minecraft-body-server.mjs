// Real vanilla server and packaged Mineflayer, only in a fresh local test world.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--accept-eula")) throw new Error("必须先由用户同意 Minecraft EULA，再传 --accept-eula；不会自动接受条款");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, ".test-runtime/minecraft-server-assets");
const javaDirectory = (await readdir(path.join(assets, "java21"))).find((name) => name.endsWith("-jre"));
const java = path.join(assets, "java21", javaDirectory, "bin/java.exe");
const run = path.join(root, ".test-runtime", `minecraft-body-server-${Date.now()}`);
await mkdir(run, { recursive: true });
const socket = net.createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
await writeFile(path.join(run, "eula.txt"), "# User explicitly accepted EULA for this isolated test server.\neula=true\n");
await writeFile(path.join(run, "server.properties"), `server-ip=127.0.0.1\nserver-port=${port}\nonline-mode=false\nenforce-secure-profile=false\nlevel-name=test-world\nlevel-type=minecraft:flat\ngenerate-structures=false\nview-distance=3\nsimulation-distance=3\nmax-players=2\ndifficulty=peaceful\nallow-flight=true\nenable-rcon=false\nenable-query=false\n`);

const server = spawn(java, ["-XX:ActiveProcessorCount=2", "-Xms256M", "-Xmx768M", "-jar", path.join(assets, "server-1.21.11.jar"), "nogui"], {
  cwd: run, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
});
let logs = "";
let exited = false;
server.stdout.on("data", (chunk) => { logs += chunk; });
server.stderr.on("data", (chunk) => { logs += chunk; });
server.once("exit", () => { exited = true; });
server.once("error", (error) => { logs += String(error); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    if (exited) throw new Error(`测试服已退出：${logs.slice(-1500)}`);
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`等待超时：${label}`);
}
async function command(...commands) { server.stdin.write(commands.join("\n") + "\n"); await sleep(300); }
const require = createRequire(path.join(root, "artifacts/minecraft-body/runtime/package.json"));
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const pluginModule = require(path.join(root, "artifacts/minecraft-body/index.cjs"));
const channels = new Map();
const cleanups = [];
const abort = new AbortController();
const forbidden = () => { throw new Error("禁止使用 Chat/Companion 服务"); };
(pluginModule.default || pluginModule).register({ signal: abort.signal,
  storage: { rootDir: () => path.join(run, "plugin-data") }, onDispose: (fn) => cleanups.push(fn),
  registerIpc: (name, handler) => channels.set(name, handler), registerTool: forbidden,
  registerPromptProvider: forbidden, registerChannelAdapter: forbidden,
  events: { on: forbidden, emit: forbidden }, deps: new Proxy({}, { get: forbidden }),
});
const invoke = (name, ...args) => channels.get(name)(...args);
const status = () => invoke("body-status");
const results = [];
const checks = [];
let owner;
async function action(request, expected = "completed") {
  await wait(() => !status().state.activeAction && !status().results.some((result) => result.status === "submitted"), "动作槽释放");
  const submitted = invoke("body-action", { timeoutMs: 15000, ...request });
  await wait(() => status().results.find((result) => result.id === submitted.id && !["active", "submitted"].includes(result.status)), `${request.action} 返回实际结果`, 21000);
  const result = status().results.find((result) => result.id === submitted.id);
  results.push(result);
  assert.equal(result.status, expected, JSON.stringify(result));
  console.log(`${request.action}: ${result.status}`);
  return result;
}
try {
  await wait(() => /Done \(.+\)!/.test(logs), "Vanilla 服务端启动", 90000);
  checks.push("Vanilla 1.21.11 started on loopback in a fresh world");
  await command("time set day", "weather clear");
  owner = mineflayer.createBot({ host: "127.0.0.1", port, username: "Owner", auth: "offline", version: "1.21.11" });
  owner.on("error", (error) => { logs += `\nOwner: ${error.message}`; });
  let ownerSpawned = false;
  owner.once("spawn", () => { ownerSpawned = true; });
  await wait(() => ownerSpawned, "主人出生");
  await owner.waitForChunksToLoad();
  // A fresh server does not keep spawn chunks loaded in this version. Build
  // the platform only after a client has loaded them, then verify the block.
  await command("fill -16 63 -16 16 63 16 minecraft:stone", "setworldspawn 0 64 0");
  await wait(() => owner.blockAt(new Vec3(0, 63, 0))?.name === "stone", "测试地形已生成");
  await invoke("body-start", { host: "127.0.0.1", port, username: "Cyrene", owner: "Owner", auth: "offline", version: "1.21.11" });
  await wait(() => status().state.connected, "身体出生");
  await command("tp Owner 8.5 64 0.5", "tp Cyrene 0.5 64 0.5", "gamemode creative Owner");
  await wait(() => status().state.owner && Math.abs(status().state.position.y - 64) < 0.1, "玩家位置和地形同步");
  assert.equal(status().state.dimension, "overworld");
  checks.push("Real protocol join, inventory/health/dimension/owner snapshots");
  await action({ action: "come" });
  await wait(() => owner.players.Cyrene?.entity?.position.distanceTo(owner.entity.position) <= 2.6, "主人客户端独立确认机器人到达");
  checks.push("Come completed and was independently observed by owner client");

  const count = status().results.length;
  owner.chat("跟随");
  await wait(() => status().notices.some((notice) => notice.data?.username === "Owner" && notice.data.text === "跟随"), "游戏聊天观察");
  assert.equal(status().state.activeAction, null);
  assert.equal(status().results.length, count);
  checks.push("Real owner chat did not dispatch an action");

  const followed = invoke("body-action", { action: "follow", timeoutMs: 10000 });
  await wait(() => status().results.some((result) => result.id === followed.id && result.status === "active"), "跟随 active");
  await command("tp Owner 12.5 64 0.5");
  await wait(() => status().state.position.x > 9, "机器人跟随移动");
  invoke("body-cancel");
  await wait(() => status().results.some((result) => result.id === followed.id && result.status === "cancelled"), "跟随取消");
  await sleep(700);
  const stopped = owner.players.Cyrene.entity.position.clone();
  await sleep(700);
  assert.ok(stopped.distanceTo(owner.players.Cyrene.entity.position) < 0.3);
  checks.push("Follow moved on real terrain; cancel stopped subsequent movement");

  const timed = invoke("body-action", { action: "follow", timeoutMs: 1000 });
  await wait(() => status().results.some((result) => result.id === timed.id && result.status === "timed_out"), "跟随期限");
  checks.push("Follow deadline produced timed_out and stopped controls");

  await command("tp Cyrene 0.5 64 0.5", "tp Owner 2.5 64 0.5", "clear Cyrene", "setblock 2 64 2 minecraft:dirt");
  await wait(() => status().state.position.x < 1 && !status().state.activeAction, "采集准备");
  const collected = await action({ action: "collect", material: "泥土", count: 1 });
  await wait(() => owner.blockAt(new Vec3(2, 64, 2))?.name === "air", "主人客户端确认方块移除");
  assert.equal(collected.progress.dug, 1);
  checks.push("Collect confirmed actual block removal independently of inventory pickup");

  await command("give Cyrene oak_log 2");
  await wait(() => (status().state.inventory.oak_log || 0) >= 2, "合成材料同步");
  const crafted = await action({ action: "craft", material: "木板", count: 4 });
  assert.equal(crafted.progress.inventoryDelta.oak_planks, 4);
  checks.push("Craft confirmed four planks through real server inventory update");
  await command("tp Owner 0.5 64 0.5", "tp Cyrene 1.5 64 0.5");
  await wait(() => status().state.position.x < 2, "交付范围");
  const given = await action({ action: "give", material: "木板", count: 2 });
  assert.equal(given.progress.transferred, 2);
  assert.equal(given.progress.inventoryDelta.oak_planks, -2);
  checks.push("Give measured items actually removed; no unverified pickup claim");

  await command("kill @e[type=minecraft:item]", "tp Owner -8.5 64 0.5", "tp Cyrene 0.5 64 0.5", 'summon minecraft:item 4.5 64.2 0.5 {Item:{id:"minecraft:diamond",count:1},PickupDelay:0s}');
  await wait(() => status().state.position.x < 1 && Object.values(owner.entities).some((entity) => entity.name === "item"), "拾取场景同步");
  const picked = await action({ action: "pickup", count: 1 });
  assert.equal(picked.progress.pickedStacks, 1);
  assert.equal(picked.progress.inventoryDelta.diamond, 1);
  checks.push("Pickup required a real inventory increase, not only entity disappearance");

  await command("tp Cyrene 0.5 64 0.5", "tp Owner 8.5 64 0.5");
  await wait(() => status().state.position.x < 1 && status().state.owner?.x > 8, "日常导航准备");
  const home = (await action({ action: "set_home" })).progress.home;
  await action({ action: "goto", position: { x: 3.5, y: 64, z: 0.5 } });
  await action({ action: "home" });
  await action({ action: "look" });
  await wait(() => owner.players.Cyrene?.entity?.position.distanceTo(new Vec3(home.position.x, home.position.y, home.position.z)) < 1.1, "主人客户端确认回家");
  checks.push("Coordinates, safe home and return were independently observed; look action completed");

  await command("give Cyrene iron_sword", "give Cyrene iron_helmet", "give Cyrene iron_chestplate", "give Cyrene iron_leggings", "give Cyrene iron_boots", "give Cyrene shield");
  await wait(() => status().state.inventory.shield && status().state.inventory.iron_boots, "装备同步");
  await action({ action: "equip", material: "铁剑" });
  await action({ action: "equip_armor" });
  await action({ action: "equip_shield" });
  await wait(() => status().state.equipment.feet === "iron_boots" && status().state.equipment.shield === "shield", "装备槽同步");
  checks.push("Hand, four armor slots and off-hand shield confirmed real inventory equipment updates");

  await command("give Cyrene torch 2", "give Cyrene crafting_table", "give Cyrene chest", "give Cyrene furnace");
  await wait(() => status().state.inventory.furnace, "放置材料同步");
  for (const [material, name, x] of [["火把", "torch", 2], ["工作台", "crafting_table", 3], ["箱子", "chest", 4], ["熔炉", "furnace", 5]]) {
    await action({ action: "place", material, position: { x, y: 64, z: 2 } });
    await wait(() => owner.blockAt(new Vec3(x, 64, 2))?.name === name, "主人客户端确认设施放置");
  }
  checks.push("Torch, crafting table, chest and furnace placement confirmed by independent owner client");
  await action({ action: "bind_chest" });
  const deposited = await action({ action: "deposit", material: "diamond", count: 1 });
  assert.equal(deposited.progress.inventoryDelta.diamond, -1);
  const listed = await action({ action: "list_chest" });
  assert.ok(listed.progress.containerAfter.some((item) => item.name === "diamond" && item.count === 1));
  const withdrawn = await action({ action: "withdraw", material: "diamond", count: 1 });
  assert.equal(withdrawn.progress.inventoryDelta.diamond, 1);
  checks.push("Bound chest listing, deposit and withdrawal confirmed both container and inventory deltas");

  await command("setblock 6 64 2 oak_door[facing=east,half=lower,open=false]", "setblock 6 65 2 oak_door[facing=east,half=upper,open=false]");
  await action({ action: "door", open: true });
  await wait(() => owner.blockAt(new Vec3(6, 64, 2))?.getProperties().open === true, "主人确认开门");
  await action({ action: "door", open: false });
  await wait(() => owner.blockAt(new Vec3(6, 64, 2))?.getProperties().open === false, "主人确认关门");
  checks.push("Wooden door open and close confirmed independently");

  await command("setblock 2 64 5 white_bed[facing=east,part=foot]", "setblock 3 64 5 white_bed[facing=east,part=head]", "time set night");
  await action({ action: "bind_bed" });
  await action({ action: "sleep" });
  await wait(() => status().state.sleeping, "真实睡眠状态");
  await action({ action: "wake" });
  await wait(() => !status().state.sleeping, "真实起床状态");
  await command("time set day");
  checks.push("Bound overworld bed sleeping and waking confirmed real server state");

  await command("setblock 6 63 5 dirt", "setblock 7 63 5 dirt", "setblock 8 63 5 water", "give Cyrene iron_hoe", "give Cyrene wheat_seeds 6", "tp Cyrene 5.5 64 4.5", "tp Owner -8.5 64 0.5");
  await wait(() => Math.abs(status().state.position.z - 4.5) < 0.1 && status().state.inventory.wheat_seeds >= 6, "农耕准备");
  await action({ action: "till", count: 2 });
  await action({ action: "plant", material: "小麦", count: 2 });
  await wait(() => owner.blockAt(new Vec3(6, 64, 5))?.name === "wheat" && owner.blockAt(new Vec3(7, 64, 5))?.name === "wheat", "主人确认两株小麦");
  await command("setblock 6 64 5 wheat[age=7]");
  const harvested = await action({ action: "harvest", material: "小麦", count: 1 });
  assert.equal(harvested.progress.changed, 1);
  await wait(() => owner.blockAt(new Vec3(6, 64, 5))?.name === "air" && owner.blockAt(new Vec3(7, 64, 5))?.name === "wheat", "只收成熟小麦");
  checks.push("Tilling, planting and mature-only harvest confirmed independently without trampling seedlings");

  await command("give Cyrene raw_iron 2", "give Cyrene coal 2");
  await wait(() => status().state.inventory.raw_iron >= 2 && status().state.inventory.coal >= 2, "烧炼材料");
  const smelted = await action({ action: "smelt", material: "铁", count: 1, timeoutMs: 25000 });
  assert.equal(smelted.progress.smelted, 1);
  assert.equal(smelted.progress.inventoryDelta.iron_ingot, 1);
  checks.push("Real furnace produced iron and confirmed output taken into inventory");

  await command("difficulty hard", "tp Cyrene 0.5 64 0.5", "summon husk 2.5 64 0.5 {NoAI:1b,Health:4.0f}");
  await wait(() => status().state.position.x < 1 && Object.values(owner.entities).some((entity) => entity.name === "husk"), "自卫场景同步");
  const defended = await action({ action: "defend", timeoutMs: 10000 });
  assert.equal(defended.progress.defeated, "husk");
  await wait(() => !Object.values(owner.entities).some((entity) => entity.name === "husk"), "主人确认敌对生物死亡");
  checks.push("Bounded melee defense confirmed a real hostile death, without attacking owner");

  await command("fill -5 63 -5 -3 63 -3 stone", "setblock -4 62 -4 stone", "setblock -4 63 -4 air", "give Cyrene cobblestone 3", "tp Cyrene -3.5 63 -3.5");
  await wait(() => status().state.position.y < 63.1 && status().state.inventory.cobblestone >= 3, "浅坑准备");
  const escaped = await action({ action: "escape" });
  assert.equal(escaped.progress.inventoryDelta[escaped.progress.usedBlock], -1);
  await wait(() => owner.blockAt(new Vec3(-4, 63, -4))?.name === escaped.progress.usedBlock && owner.players.Cyrene?.entity?.position.y >= 64, "主人确认垫脚并离开浅坑");
  checks.push("One-block shallow pit escape consumed one block and reached a verified safe exit");

  // Reset checkpoints after deliberate terrain changes in the daily-action scenarios.
  await invoke("body-stop");
  await invoke("body-start", { host: "127.0.0.1", port, username: "Cyrene", owner: "Owner", auth: "offline", version: "1.21.11" });
  await wait(() => status().state.connected, "日常动作后重连");
  await command("tp Cyrene 0.5 64 0.5", "effect give Cyrene minecraft:instant_health 1 10 true", "effect give Cyrene minecraft:saturation 1 255 true");
  await wait(() => status().state.health === 20 && status().state.food === 20 && status().state.position.x < 1, "生存基线恢复");
  await sleep(1200);

  await command("difficulty hard", "give Cyrene minecraft:bread 8", "effect give Cyrene minecraft:hunger 15 255 true");
  await wait(() => status().state.food <= 12, "饥饿准备");
  await command("effect clear Cyrene minecraft:hunger");
  const eaten = await action({ action: "eat" });
  assert.ok(eaten.progress.foodGained > 0);
  assert.equal(eaten.progress.inventoryDelta.bread, -1);
  checks.push("Safe eating consumed bread and increased actual hunger points");
  await command("damage Cyrene 15 minecraft:generic");
  await wait(() => status().state.health <= 6, "低血量准备");
  const retreated = await action({ action: "retreat" });
  const anchor = retreated.before.survival.safePoints[0];
  assert.ok(Math.hypot(retreated.after.position.x - anchor.x, retreated.after.position.y - anchor.y, retreated.after.position.z - anchor.z) <= 1.5);
  await wait(() => owner.players.Cyrene?.entity?.position.distanceTo(new Vec3(anchor.x, anchor.y, anchor.z)) <= 1.5, "主人确认撤回终点");
  checks.push("Low-health retreat followed recorded safe points and verified the endpoint");
  await command("effect give Cyrene minecraft:instant_health 1 10 true", "effect give Cyrene minecraft:saturation 1 255 true");
  await wait(() => status().state.health === 20 && status().state.food === 20, "生命值与饥饿值恢复");
  await sleep(1200);

  await invoke("body-stop");
  await invoke("body-start", { host: "127.0.0.1", port, username: "Cyrene", owner: "Owner", auth: "offline", version: "1.21.11", autoSurvival: true });
  await wait(() => status().state.connected, "可选自动生存连接");
  await command("tp Cyrene 0.5 64 0.5", "tp Owner 10.5 64 0.5");
  await wait(() => status().state.position.x < 1 && status().state.owner?.x > 10, "自动生存场景位置同步");
  await command("effect give Cyrene minecraft:hunger 15 255 true");
  await wait(() => status().state.food < 14, "自动进食阈值");
  await command("effect clear Cyrene minecraft:hunger");
  await wait(() => status().results.some((result) => result.id.startsWith("survival-") && result.action === "eat" && result.status === "completed"), "自动进食", 20000);
  await command("effect give Cyrene minecraft:saturation 1 255 true");
  await wait(() => status().state.food === 20, "自动进食后的场景复位");
  assert.equal(status().state.survival.enabled, true);
  checks.push("Opt-in automatic survival ate through the same exclusive action slot");
  await wait(() => !status().state.activeAction, "自动进食结束");
  await action({ action: "come" });
  await sleep(15000);
  const hurt = invoke("body-action", { action: "follow", timeoutMs: 20000 });
  await wait(() => status().results.some((result) => result.id === hurt.id && result.status === "active"), "受伤前跟随");
  await command("damage Cyrene 15 minecraft:generic");
  await wait(() => status().results.some((result) => result.id === hurt.id && result.status === "cancelled"), "低血量中断跟随");
  await wait(() => status().results.some((result) => result.id.startsWith("survival-") && result.action === "retreat" && result.status === "completed"), "自动撤回", 20000);
  checks.push("Low health cancelled follow then automatically retreated without concurrent actions");
  await command("effect give Cyrene minecraft:instant_health 1 10 true");
  await wait(() => status().state.health > 6 && !status().state.activeAction, "自动撤回后恢复");
  const respawnHome = (await action({ action: "set_home" })).progress.home;

  const dying = invoke("body-action", { action: "follow", timeoutMs: 10000 });
  await wait(() => status().results.some((result) => result.id === dying.id && result.status === "active"), "死亡前跟随");
  await command("kill Cyrene");
  await wait(() => status().results.some((result) => result.id === dying.id && ["cancelled", "disconnected"].includes(result.status)), "死亡取消动作");
  await wait(() => status().state.connected && status().state.health > 0 && !status().state.activeAction, "重生且动作未重放");
  checks.push("Death stopped follow; respawn did not replay it");
  await wait(() => status().state.owner && owner.players.Cyrene?.entity, "重生后的玩家实体重新同步");
  assert.deepEqual(status().state.bookmarks.home, respawnHome);
  checks.push("Rebirth retained explicit session bookmarks while discarding the previous action");
  const disconnected = invoke("body-action", { action: "follow", timeoutMs: 10000 });
  await wait(() => status().results.some((result) => result.id === disconnected.id && result.status === "active"), "断线前跟随");
  await command("kick Cyrene isolated-disconnect-test");
  await wait(() => !status().running && !status().state.connected, "网络断线关闭身体");
  await sleep(1000);
  assert.equal(status().running, false);
  checks.push("Server disconnect ended child; no reconnect or action replay");
  await writeFile(path.join(run, "result.json"), JSON.stringify({ ok: true, version: "1.21.11", realVanillaServer: true,
    loopbackOnly: true, conversationServicesUsed: false, checks, results, finalStatus: status() }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, report: path.join(run, "result.json") }, null, 2));
} catch (error) {
  await writeFile(path.join(run, "result.json"), JSON.stringify({ ok: false, checks, results, error: String(error), status: status() }, null, 2));
  console.error(`${error}\nReport: ${run}`);
  process.exitCode = 1;
} finally {
  abort.abort();
  for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch (error) { console.error(error); process.exitCode = 1; } }
  owner?.quit();
  if (!exited) {
    server.stdin.write("stop\n");
    for (let i = 0; i < 100 && !exited; i++) await sleep(100);
    if (!exited) server.kill();
  }
  await writeFile(path.join(run, "server.log"), logs);
}
