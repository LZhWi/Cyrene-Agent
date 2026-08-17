"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

function run(userData, query) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "context-retrieval-worker.cjs"), { workerData: { userData, query } });
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

test("retrieves by phrases instead of common single-character overlap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-mc-retrieval-"));
  fs.mkdirSync(path.join(root, "rag-data"), { recursive: true });
  fs.writeFileSync(path.join(root, "memory.json"), JSON.stringify({ l2: [
    { content: "用户喜欢临水的家", triggerText: "湖边建家", status: "active" },
    { content: "归档内容", status: "archived" },
  ] }));
  fs.writeFileSync(path.join(root, "rag-data", "memory-store.json"), JSON.stringify([
    { source: "chat_history", text: "我们以后住在水边吧", createdAt: 1 },
    { source: "chat_history", text: "完全无关的旧话题", createdAt: 2 },
  ]));
  const result = await run(root, "找湖边建家的地方");
  assert.deepEqual(result.memories, ["用户喜欢临水的家"]);
  assert.deepEqual(result.conversation.map((item) => item.content), ["我们以后住在水边吧"]);
});
