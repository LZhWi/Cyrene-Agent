import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { endpoint, readReferencedConfig } from "../plugins/companion-chat/src/model";
import { kimiReviewRequest, locateAndVerifySource, mergeReviewCandidates, type ReviewMessage } from "./support/source-review";
import { storedSemanticCandidates, type StoredVector } from "./support/semantic-candidates";
import { matchTrigger, nearbyCandidates, type SourceSession } from "./support/trigger-matcher";

// 只有显式授权后才运行：源数据只读，候选只在内存中处理，模型原文与真实 ID 均不落盘、不输出。
it.runIf(process.env.CYRENE_REAL_SOURCE_REVIEW === "1")("Kimi 双阶段来源复核：真实数据只读、前后哈希一致", async () => {
  const root = path.join(homedir(), "AppData/Roaming/live2d-cyrene");
  const sessionDirectory = path.join(root, "cyrene-chats/sessions");
  const modelFile = path.join(root, "model-settings.json");
  const hashes = new Map<string, string>();
  const digest = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
  function readJson(file: string, maxBytes = 64 * 1024 * 1024): any {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || path.normalize(realpathSync(file)).toLowerCase() !== path.normalize(file).toLowerCase()) throw new Error("源文件类型、大小或路径校验失败");
    const buffer = readFileSync(file);
    hashes.set(file, digest(buffer));
    try { return JSON.parse(buffer.toString("utf8")); } catch { throw new Error("源 JSON 解析失败（不输出原文）"); }
  }

  let modelRequests = 0;
  try {
    const memory = readJson(path.join(root, "memory.json"));
    const vectors = readJson(path.join(root, "rag-data", "memory-store.json")) as StoredVector[];
    // 将配置文件纳入同一哈希护栏；随后复用生产代码的严格配置校验。
    readJson(modelFile, 2 * 1024 * 1024);
    const model = readReferencedConfig(modelFile);
    expect(Array.isArray(memory?.l2) && Array.isArray(vectors)).toBe(true);

    const sessions: SourceSession[] = [];
    for (const name of readdirSync(sessionDirectory).filter((item) => /^[a-zA-Z0-9_-]+\.json$/.test(item))) {
      const raw = readJson(path.join(sessionDirectory, name));
      if (raw?.id !== name.slice(0, -5) || raw.schemaVersion !== 1 || !Array.isArray(raw.messages) || raw.messages.some((message: any) => !message || typeof message.id !== "string" || !["user", "model"].includes(message.role) || typeof message.content !== "string" || !Number.isFinite(message.at))) throw new Error("会话格式不兼容（不输出原文）");
      if (new Set(raw.messages.map((message: any) => message.id)).size !== raw.messages.length) throw new Error("会话消息 ID 重复");
      sessions.push({ id: raw.id, messages: raw.messages.map((message: any) => ({ id: message.id, role: message.role, content: message.content, at: message.at })) });
    }

    const unresolved = memory.l2.filter((item: any) => item?.isSummary !== true && typeof item?.id === "string" && typeof item?.content === "string" && typeof item?.triggerText === "string" && Number.isFinite(item?.createdAt) && ["ambiguous", "no-match"].includes(matchTrigger(item.triggerText, sessions).method));
    if (unresolved.length > 20) throw new Error("待复核数量超出本次授权范围");

    const generate = async (messages: ReviewMessage[]): Promise<string> => {
      modelRequests++;
      const response = await fetch(endpoint(model.baseUrl), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(120000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${model.apiKey}` },
        body: JSON.stringify(kimiReviewRequest(model.model, messages)),
      });
      if (!response.ok) throw new Error(`模型请求失败（HTTP ${response.status}）`);
      const data = await response.json() as any;
      const choice = data?.choices?.[0];
      if (choice?.finish_reason !== "stop" || typeof choice?.message?.content !== "string" || !choice.message.content.trim()) throw new Error("模型输出不完整");
      return choice.message.content.trim();
    };

    let resolved = 0, selectedMessages = 0;
    const locateConfidences: number[] = [], verifyConfidences: number[] = [];
    for (const item of unresolved) {
      const semantic = storedSemanticCandidates(item.id, vectors, sessions, 8);
      const nearby = nearbyCandidates(item.createdAt, sessions, 4);
      const candidates = mergeReviewCandidates(semantic, nearby, 12);
      const result = await locateAndVerifySource(item, candidates, generate);
      if (!result) continue;
      resolved++; selectedMessages += result.candidates.length;
      locateConfidences.push(result.locateConfidence); verifyConfidences.push(result.verifyConfidence);
    }
    const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    console.log("READONLY_SOURCE_REVIEW_SUMMARY " + JSON.stringify({ evaluated: unresolved.length, resolved, unresolved: unresolved.length - resolved, selectedMessages, locateConfidenceAverage: average(locateConfidences), verifyConfidenceAverage: average(verifyConfidences), sourceFilesRead: hashes.size, modelRequests, sourceWrites: 0, activationChanges: 0, accessCounterChanges: 0, dmaeCalls: 0 }));
  } finally {
    let changed = 0;
    for (const [file, before] of hashes) if (digest(readFileSync(file)) !== before) changed++;
    expect(changed, "有源文件在复核期间变化；不回写、不锁定，请在稳定时段重试").toBe(0);
  }
}, 20 * 60 * 1000);
