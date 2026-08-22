import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { writeFileAtomic } = require("../dist/main/main/runtime/atomic-file.js");
const userData = path.join(process.env.APPDATA ?? os.homedir(), "live2d-cyrene");
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-io-smoke-"));
const hash = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function largestFile(directory) {
  if (!fs.existsSync(directory)) return null;
  return fs.readdirSync(directory)
    .map((name) => path.join(directory, name))
    .filter((filePath) => fs.statSync(filePath).isFile())
    .map((filePath) => ({ filePath, bytes: fs.statSync(filePath).size }))
    .sort((a, b) => b.bytes - a.bytes)[0] ?? null;
}

async function measure(operation) {
  const intervalMs = 2;
  let expected = performance.now() + intervalMs;
  let maxEventLoopLagMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxEventLoopLagMs = Math.max(maxEventLoopLagMs, now - expected);
    expected = now + intervalMs;
  }, intervalMs);
  await new Promise((resolve) => setImmediate(resolve));
  const startedAt = performance.now();
  const value = await operation();
  const durationMs = performance.now() - startedAt;
  await new Promise((resolve) => setTimeout(resolve, intervalMs * 3));
  clearInterval(timer);
  return { value, durationMs: Number(durationMs.toFixed(2)), maxEventLoopLagMs: Number(maxEventLoopLagMs.toFixed(2)) };
}

try {
  const chatSample = largestFile(path.join(userData, "cyrene-chats", "sessions"));
  const audioSample = largestFile(path.join(userData, "cyrene-tts-cache"));
  if (!chatSample || !audioSample) throw new Error("real chat or TTS cache sample is unavailable");
  const chatBefore = fs.readFileSync(chatSample.filePath);
  const audioBefore = fs.readFileSync(audioSample.filePath);

  const diskChatReads = await measure(() => {
    for (let index = 0; index < 50; index++) JSON.parse(fs.readFileSync(chatSample.filePath, "utf8"));
  });
  const cachedChat = JSON.parse(chatBefore.toString("utf8"));
  const cachedChatReads = await measure(() => {
    for (let index = 0; index < 50; index++) structuredClone(cachedChat);
  });
  const syncAudioRead = await measure(() => fs.readFileSync(audioSample.filePath));
  const asyncAudioRead = await measure(() => fs.promises.readFile(audioSample.filePath));

  const isolatedAudio = path.join(isolated, "audio-cache.bin");
  const asyncAudioWrite = await measure(() => writeFileAtomic(isolatedAudio, audioBefore));
  const written = fs.readFileSync(isolatedAudio);
  if (hash(written) !== hash(audioBefore)) throw new Error("isolated async audio write mismatch");
  if (hash(fs.readFileSync(chatSample.filePath)) !== hash(chatBefore)) throw new Error("source chat changed");
  if (hash(fs.readFileSync(audioSample.filePath)) !== hash(audioBefore)) throw new Error("source audio changed");

  console.log(JSON.stringify({
    ok: true,
    isolated: true,
    sourceUnchanged: true,
    samples: { chatBytes: chatSample.bytes, audioBytes: audioSample.bytes },
    measurements: {
      diskChatReads: { durationMs: diskChatReads.durationMs, maxEventLoopLagMs: diskChatReads.maxEventLoopLagMs },
      cachedChatReads: { durationMs: cachedChatReads.durationMs, maxEventLoopLagMs: cachedChatReads.maxEventLoopLagMs },
      syncAudioRead: { durationMs: syncAudioRead.durationMs, maxEventLoopLagMs: syncAudioRead.maxEventLoopLagMs },
      asyncAudioRead: { durationMs: asyncAudioRead.durationMs, maxEventLoopLagMs: asyncAudioRead.maxEventLoopLagMs },
      asyncAudioWrite: { durationMs: asyncAudioWrite.durationMs, maxEventLoopLagMs: asyncAudioWrite.maxEventLoopLagMs },
    },
  }, null, 2));
} finally {
  fs.rmSync(isolated, { recursive: true, force: true });
}
