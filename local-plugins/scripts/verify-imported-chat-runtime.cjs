"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const projectRoot = path.resolve(__dirname, "..", "..");
const sourceRoot = path.resolve(process.env.CYRENE_IMPORTED_CHAT_ROOT
  || path.join(projectRoot, "..", "AppData", "Roaming", "live2d-cyrene-n", "cyrene-chats"));
const runtimeRoot = path.join(projectRoot, "local-plugins", ".test-runtime", `chat-import-${crypto.randomUUID()}`);
const resultPath = path.join(projectRoot, "local-plugins", ".test-runtime", "chat-import-last-result.json");
const userDataRoot = path.join(runtimeRoot, "user-data");
const copiedRoot = path.join(userDataRoot, "cyrene-chats");

function treeHash(root) {
  const hash = crypto.createHash("sha256");
  function visit(current, relative = "") {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = path.join(current, entry.name);
      const rel = path.join(relative, entry.name).replace(/\\/g, "/");
      const stat = fs.lstatSync(next);
      if (stat.isSymbolicLink()) throw new Error(`拒绝符号链接：${rel}`);
      hash.update(`${entry.isDirectory() ? "D" : "F"}:${rel}\0`);
      if (entry.isDirectory()) visit(next, rel);
      else if (entry.isFile()) hash.update(fs.readFileSync(next));
      else throw new Error(`不支持的文件类型：${rel}`);
    }
  }
  visit(root);
  return hash.digest("hex");
}

if (!sourceRoot || path.basename(sourceRoot).toLowerCase() !== "cyrene-chats"
  || !fs.lstatSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error("CYRENE_IMPORTED_CHAT_ROOT 必须指向 N 的 cyrene-chats 目录");
}

const beforeHash = treeHash(sourceRoot);
fs.mkdirSync(userDataRoot, { recursive: true });
fs.cpSync(sourceRoot, copiedRoot, { recursive: true, errorOnExist: true });
app.setPath("userData", userDataRoot);

function cleanupRuntime() {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}

app.whenReady().then(() => {
  const store = require(path.join(projectRoot, "dist", "main", "main", "chats", "chats-store.js"));
  store.initialize();
  const chats = store.listSessions({ mode: "chat" });
  if (chats.length !== 1 || chats[0].messageCount !== 1508) throw new Error("运行时 Chat 索引数量不符");
  const session = store.getSession(chats[0].id);
  if (!session || session.mode !== "chat" || session.messages.length !== 1508) throw new Error("运行时会话读取失败");
  const page = store.getSessionPage(chats[0].id, null, 100);
  if (page.messages.length !== 100 || page.hasMore !== true || page.session.messageCount !== 1508) {
    throw new Error("运行时分页读取失败");
  }
  const ids = new Set(session.messages.map((message) => message.id));
  if (ids.size !== 1508 || session.messages.some((message) => !Number.isFinite(message.at))) {
    throw new Error("运行时消息 ID 或时间戳异常");
  }
  const copiedHash = treeHash(copiedRoot);
  const afterHash = treeHash(sourceRoot);
  if (beforeHash !== copiedHash || beforeHash !== afterHash) throw new Error("运行时读取改变了聊天数据");
  const result = { ok: true, chatSessions: chats.length, messages: session.messages.length,
    pageSize: page.messages.length, sourceUnchanged: true, copiedSnapshotUnchanged: true };
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`);
  console.log(JSON.stringify(result));
  cleanupRuntime();
  app.exit(0);
}).catch((error) => {
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  console.error(error instanceof Error ? error.message : String(error));
  cleanupRuntime();
  app.exit(1);
});

app.on("will-quit", cleanupRuntime);
