import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ dataDir: "", responseText: "[]", messages: [] as Array<{ role: string; content: string }> }));
vi.mock("../runtime/runtime-paths", () => ({ getUserDataDir: () => mock.dataDir }));
vi.mock("../token-usage-store", () => ({ recordUsage: vi.fn() }));
vi.mock("../orchestrator/vendors", () => ({ getAdapterForConfig: () => ({
  buildRequest: (request: { messages: Array<{ role: string; content: string }> }) => {
    mock.messages = request.messages;
    return { url: "http://mock.invalid/chat", headers: {}, body: "{}" };
  },
  parseResponse: () => ({ text: mock.responseText }),
}) }));

import { memoryJudge } from "./memory-judge";

const corpusPath = process.env.CYRENE_MEMORY_AB_CORPUS;
const outputPath = process.env.CYRENE_MEMORY_AB_LOCAL_PROMPTS;
const parseRun = process.env.CYRENE_MEMORY_AB_PARSE_RUN;

beforeAll(() => {
  if (!corpusPath || (!outputPath && !parseRun)) return;
  mock.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-memory-ab-"));
  fs.writeFileSync(path.join(mock.dataDir, "model-settings.json"), JSON.stringify({
    provider: "mock", baseUrl: "http://mock.invalid", model: "mock", apiKey: "not-a-real-key",
  }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (mock.dataDir) fs.rmSync(mock.dataDir, { recursive: true, force: true });
});

it.skipIf(!corpusPath || !outputPath || Boolean(parseRun))("captures the real local MemoryJudge prompt without calling a model", async () => {
  const corpus = JSON.parse(fs.readFileSync(corpusPath!, "utf8")) as { cases: Array<{
    id: string; conversationId: string; turns: Array<{ user: string; assistant: string; userAt: string; assistantAt: string }>;
  }> };
  const prompts = [];
  for (const item of corpus.cases) for (const size of [8, 12]) {
    mock.messages = [];
    const turns = item.turns.slice(-size).map((turn) => ({ userInput: turn.user, assistantReply: turn.assistant,
      userAt: Date.parse(turn.userAt), assistantAt: Date.parse(turn.assistantAt) }));
    await memoryJudge.judgeRecentTurns(turns, item.conversationId);
    expect(mock.messages.map((message) => message.role)).toEqual(["system", "user"]);
    prompts.push({ caseId: item.id, size, messages: structuredClone(mock.messages) });
  }
  const sourceSha256 = createHash("sha256").update(fs.readFileSync(path.join(__dirname, "memory-judge.ts"))).digest("hex");
  fs.writeFileSync(outputPath!, JSON.stringify({ version: 1, sourceSha256, prompts }, null, 2) + "\n",
    { encoding: "utf8", flag: "wx" });
  expect(prompts).toHaveLength(6);
});

it.skipIf(!corpusPath || !parseRun)("parses recorded local outputs with the real MemoryJudge without another model call", async () => {
  const corpus = JSON.parse(fs.readFileSync(corpusPath!, "utf8")) as { cases: Array<{
    id: string; conversationId: string; turns: Array<{ user: string; assistant: string; userAt: string; assistantAt: string }>;
  }> };
  const results = [];
  for (const item of corpus.cases) for (const size of [8, 12]) {
    const recordPath = path.join(parseRun!, `${item.id}-local-${size}.json`);
    if (!fs.existsSync(recordPath)) continue;
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    mock.responseText = record.text;
    const turns = item.turns.slice(-size).map((turn) => ({ userInput: turn.user, assistantReply: turn.assistant,
      userAt: Date.parse(turn.userAt), assistantAt: Date.parse(turn.assistantAt) }));
    try {
      const candidates = await memoryJudge.judgeRecentTurns(turns, item.conversationId);
      results.push({ caseId: item.id, size, candidates });
    } catch (error) {
      results.push({ caseId: item.id, size, error: String(error) });
    }
  }
  fs.writeFileSync(path.join(parseRun!, "local-parsed.json"), JSON.stringify({ version: 1, results }, null, 2) + "\n",
    { encoding: "utf8", flag: "wx" });
  expect(results.length).toBeGreaterThan(0);
});
