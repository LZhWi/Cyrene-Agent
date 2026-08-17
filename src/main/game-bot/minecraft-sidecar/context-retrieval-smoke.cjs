"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");

const userData = process.argv[2];
const query = process.argv[3] || "Minecraft 联机 建家";
if (!userData) throw new Error("usage: node context-retrieval-smoke.cjs <userData> [query]");

const started = Date.now();
const worker = new Worker(path.join(__dirname, "context-retrieval-worker.cjs"), {
  workerData: { userData, query },
});
const timer = setTimeout(() => {
  void worker.terminate();
  process.stdout.write(`${JSON.stringify({ ok: false, error: "timeout", elapsedMs: Date.now() - started })}\n`);
  process.exitCode = 1;
}, 1_500);

worker.once("message", (result) => {
  clearTimeout(timer);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    elapsedMs: Date.now() - started,
    conversationCount: Array.isArray(result?.conversation) ? result.conversation.length : 0,
    memoryCount: Array.isArray(result?.memories) ? result.memories.length : 0,
  })}\n`);
});
worker.once("error", (error) => {
  clearTimeout(timer);
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, elapsedMs: Date.now() - started })}\n`);
  process.exitCode = 1;
});
