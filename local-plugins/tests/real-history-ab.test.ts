import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { env, pipeline } from "@xenova/transformers";
import { sanitizeHistoryRetrievalQuery } from "../plugins/companion-memory/src/history-retrieval";

const localRag = "C:/Users/ASUS/AppData/Roaming/live2d-cyrene/rag-data/memory-store.json";
const casesFile = "C:/Users/ASUS/AppData/Roaming/live2d-cyrene/rag-data/eval/history-retrieval-cases.json";
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

it.skipIf(process.env.CYRENE_REAL_DATA_AB !== "1")("real-data history baseline A/B compares raw and sanitized query without writes", async () => {
  const { JsonVectorStore } = await import("../../../Cyrene-Agent/src/main/rag/vectorstore");
  const { HybridRetriever } = await import("../../../Cyrene-Agent/src/main/rag/retriever");
  const before = [hash(localRag), hash(casesFile)];
  const cases = JSON.parse(fs.readFileSync(casesFile, "utf8")) as Array<{ query: string; expectedAny: string[] }>;
  const entries = JSON.parse(fs.readFileSync(localRag, "utf8")) as Array<{ source: string; createdAt: number }>;
  expect(cases).toHaveLength(20);
  const history = entries.filter((entry) => entry.source === "chat_history");
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const olderThan90Days = history.filter((entry) => entry.createdAt < cutoff).length;

  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.useBrowserCache = false;
  env.localModelPath = path.resolve(process.cwd(), "../models");
  const pipe = await pipeline("feature-extraction", "Xenova/bge-m3");
  const embed = async (text: string) => Array.from((await pipe(text, { pooling: "mean", normalize: true })).data);
  const provider = { name: "local-bge-m3", dims: 1024, embed,
    embedBatch: async (texts: string[]) => Promise.all(texts.map(embed)) };
  const retriever = new HybridRetriever(new JsonVectorStore(path.dirname(localRag)), provider);
  let originalQueryChanged = 0, rawTop1 = 0, cleanTop1 = 0, rawTop5 = 0, cleanTop5 = 0;
  for (const testCase of cases) {
    if (sanitizeHistoryRetrievalQuery(testCase.query) !== testCase.query) originalQueryChanged++;
    // Use a real question and answer anchor, with only a synthetic source marker added.
    const tagged = `[回忆] ${testCase.query}`;
    const raw = await retriever.retrieve(tagged, "chat_history", 5, { recordRecall: false });
    const clean = await retriever.retrieve(sanitizeHistoryRetrievalQuery(tagged), "chat_history", 5, { recordRecall: false });
    const relevant = (text: string) => testCase.expectedAny.some((anchor) => text.includes(anchor));
    if (raw[0] && relevant(raw[0].entry.text)) rawTop1++;
    if (clean[0] && relevant(clean[0].entry.text)) cleanTop1++;
    if (raw.some((hit) => relevant(hit.entry.text))) rawTop5++;
    if (clean.some((hit) => relevant(hit.entry.text))) cleanTop5++;
  }
  expect([hash(localRag), hash(casesFile)]).toEqual(before);
  console.log("[ReadOnlyHistoryAB]", JSON.stringify({ cases: cases.length, originalQueryChanged,
    olderThan90Days, rawTop1, cleanTop1, rawTop5, cleanTop5 }));
}, 240_000);
