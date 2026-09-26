import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { env, pipeline } from "@xenova/transformers";
import { JsonVectorStore } from "../../../../Cyrene-Agent/src/main/rag/vectorstore";
import { HybridRetriever } from "../../../../Cyrene-Agent/src/main/rag/retriever";
import { rankDetachedMemoryCandidates } from "../../src/main/rag/retriever";
import { historyIndexText } from "../../src/main/chats/history-index-text";
import { createHistoryRetrieval } from "../plugins/companion-memory/src/history-retrieval";

const localRag = "C:/Users/ASUS/AppData/Roaming/live2d-cyrene/rag-data/memory-store.json";
const nSession = "E:/Philia093 demo/Cyrene-Agent-N/AppData/Roaming/live2d-cyrene-n/cyrene-chats/sessions/5feb9624-db36-45c1-bf04-47aba12c0342.json";
const nRecallState = "E:/Philia093 demo/Cyrene-Agent-N/AppData/Roaming/live2d-cyrene-n/plugin-data/companion-memory/history-retrieval-recall-state.json";
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

it.skipIf(process.env.CYRENE_REAL_DATA_AB !== "1")("real-data image retrieval A/B is read-only and measures positive and unrelated queries", async () => {
  const before = [hash(localRag), hash(nSession), hash(nRecallState)];
  const entries = JSON.parse(fs.readFileSync(localRag, "utf8")) as Array<{ id: string; source: string; text: string; lastRecalledAt: number; metadata?: { turnId?: string; summary?: string } }>;
  const session = JSON.parse(fs.readFileSync(nSession, "utf8")) as { id: string; messages: Array<any> };
  const images = entries.filter((entry) => entry.source === "chat_image" && entry.metadata?.summary);
  const hosts = session.messages.map((message) => ({
    id: message.id, sessionId: session.id, role: message.role === "model" ? "assistant" as const : "user" as const,
    text: historyIndexText(message), at: message.at,
    images: (message.attachments ?? []).filter((attachment: any) => attachment.kind === "image")
      .flatMap((attachment: any) => {
        const caption = String(attachment.visualIndexCaption ?? attachment.caption ?? "").trim();
        return caption ? [{ name: attachment.name, caption, summary: attachment.visualIndexSummary,
          indexedAt: attachment.visualIndexedAt }] : [];
      }),
  }));
  const mapped = hosts.flatMap((message) => message.images.map((image: { name: string; caption: string; summary?: string }, index: number) => ({
    message, image, index,
    local: images.filter((entry) => entry.metadata?.turnId === message.id && entry.metadata?.summary === image.summary),
  }))).filter((item) => item.image.summary && item.local.length === 1 && item.message.images.length === 1);
  expect(mapped.length).toBeGreaterThanOrEqual(10);
  const positives = Array.from({ length: 10 }, (_, index) => mapped[Math.floor(index * mapped.length / 10)]);
  const unrelated = [
    "钛合金潜水艇的螺旋桨", "月球矿井的钻孔机", "火山测量仪的电路板", "量子计算机冷却管",
    "太空站外壁太阳能板", "深海珊瑚礁地形图", "古代楔形文字泥板", "航天火箭发动机喷口",
    "纳米机器人血管手术", "南极冰芯采样设备",
  ];
  expect(unrelated.every((query) => images.every((entry) => !entry.text.includes(query)))).toBe(true);

  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.useBrowserCache = false;
  env.localModelPath = path.resolve(process.cwd(), "../models");
  const pipe = await pipeline("feature-extraction", "Xenova/bge-m3");
  const embed = async (text: string) => Array.from((await pipe(text, { pooling: "mean", normalize: true })).data);
  const provider = { name: "local-bge-m3", dims: 1024, embed,
    embedBatch: async (texts: string[]) => Promise.all(texts.map(embed)) };
  const local = new HybridRetriever(new JsonVectorStore(path.dirname(localRag)), provider);
  const createN = (state: Map<string, unknown>) => createHistoryRetrieval({
    turns: () => [], hostMessages: async () => hosts,
    service: {
      embed: async (texts: string[]) => ({ vectors: await provider.embedBatch(texts), identity: { provider: "local", model: "Xenova/bge-m3", dimensions: 1024 } }),
      rank: async (input: any) => rankDetachedMemoryCandidates(input.query, input.candidates, input.topK,
        { provider, reranker: null, mode: input.mode, rawScore: input.rawScore }),
    } as any,
    storage: { get: <T>(key: string) => state.get(key) as T | undefined, set: (key, value) => { state.set(key, value); }, rootDir: () => "in-memory" },
  });
  const n = createN(new Map([["history-retrieval-recall-state", JSON.parse(fs.readFileSync(nRecallState, "utf8"))]]));
  const normalizedState = new Map<string, unknown>();
  normalizedState.set("history-retrieval-recall-state", { version: 1, entries: Object.fromEntries(mapped.map((item) => [
    `host-image:${session.id}:${item.message.id}:${item.index}`,
    { weight: 1, lastRecalledAt: item.local[0].lastRecalledAt },
  ])) });
  const nMatchedTime = createN(normalizedState);
  let localTop1 = 0, localTop5 = 0, nTop1 = 0, nTop5 = 0, nMatchedTimeTop1 = 0, nMatchedTimeTop5 = 0;
  let localFalseRecall = 0, nFalseRecall = 0, nMatchedTimeFalseRecall = 0;
  const pairedText = mapped.reduce((counts, item) => {
    if (item.local[0].text.includes(item.image.caption)) counts.captionIncluded++;
    if (item.local[0].text.includes(item.image.summary ?? "")) counts.summaryIncluded++;
    return counts;
  }, { captionIncluded: 0, summaryIncluded: 0 });
  for (const [index, query] of [...positives.map((item) => item.image.summary), ...unrelated].entries()) {
    const localHits = (await local.retrieve(query, "chat_image", 20, { recordRecall: false }))
      .filter((hit) => typeof hit.entry.metadata?.summary === "string").slice(0, 5).map((hit) => hit.entry.id);
    const result = await n.searchImagesForTool(query, new AbortController().signal);
    const nHits = [...result.matchAll(/imageId=([^\s]+)/g)].map((match) => match[1]);
    const matchedResult = await nMatchedTime.searchImagesForTool(query, new AbortController().signal);
    const matchedHits = [...matchedResult.matchAll(/imageId=([^\s]+)/g)].map((match) => match[1]);
    if (index < 10) {
      const goldLocal = positives[index].local[0].id;
      const goldN = `host-image:${session.id}:${positives[index].message.id}:${positives[index].index}`;
      if (localHits[0] === goldLocal) localTop1++;
      if (localHits.includes(goldLocal)) localTop5++;
      if (nHits[0] === goldN) nTop1++;
      if (nHits.includes(goldN)) nTop5++;
      if (matchedHits[0] === goldN) nMatchedTimeTop1++;
      if (matchedHits.includes(goldN)) nMatchedTimeTop5++;
    } else {
      if (localHits.length) localFalseRecall++;
      if (nHits.length) nFalseRecall++;
      if (matchedHits.length) nMatchedTimeFalseRecall++;
    }
  }
  expect([hash(localRag), hash(nSession), hash(nRecallState)]).toEqual(before);
  console.log("[ReadOnlyImageAB]", JSON.stringify({ positiveCases: 10, negativeCases: 10,
    localTop1, localTop5, nTop1, nTop5, nMatchedTimeTop1, nMatchedTimeTop5,
    localFalseRecall, nFalseRecall, nMatchedTimeFalseRecall, pairedImages: images.length,
    matchedSingleImageMessages: mapped.length, ...pairedText }));
}, 240_000);
