import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAsrStream: vi.fn(),
  shutdownAsrRuntimes: vi.fn(),
  getAsrConfig: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
vi.mock("./asr-factory", () => ({
  createAsrStream: mocks.createAsrStream,
  shutdownAsrRuntimes: mocks.shutdownAsrRuntimes,
}));
vi.mock("./volcano-asr-engine", () => ({ getAsrConfig: mocks.getAsrConfig }));

import {
  finishAsrTestTurn,
  flushAsrTestPartial,
  sendAsrTestAudio,
  startAsrTest,
  stopAsrTest,
} from "./asr-test-manager";

function sender() {
  return {
    sent: [] as Array<[string, unknown]>,
    isDestroyed: () => false,
    send(channel: string, payload: unknown) { this.sent.push([channel, payload]); },
    once: vi.fn(),
  };
}

describe("ASR test manager", () => {
  beforeEach(() => {
    mocks.createAsrStream.mockReset();
    mocks.shutdownAsrRuntimes.mockReset();
    mocks.getAsrConfig.mockReturnValue({
      engine: "local", appKey: "", accessKeyId: "", accessKeySecret: "",
      language: "zh", localProfile: "paraformer-qwen17", hotwords: [],
    });
  });

  afterEach(() => stopAsrTest());

  it("refuses to start while a real call is active", async () => {
    const result = await startAsrTest(sender() as never, () => true);
    expect(result.ok).toBe(false);
    expect(mocks.createAsrStream).not.toHaveBeenCalled();
  });

  it("streams PCM, emits recognition text and restarts after a VAD turn", async () => {
    const streams = Array.from({ length: 2 }, () => ({
      start: vi.fn(async () => {}),
      sendAudio: vi.fn(),
      flush: vi.fn(),
      finish: vi.fn(async () => {}),
      stop: vi.fn(),
    }));
    mocks.createAsrStream.mockImplementation((_config, onPartial, onFinal, onStatus) => {
      const next = streams[mocks.createAsrStream.mock.calls.length - 1];
      if (mocks.createAsrStream.mock.calls.length === 1) {
        queueMicrotask(() => {
          onStatus({ phase: "downloading", model: "Qwen/Qwen3-ASR-1.7B" });
          onPartial("实时文字");
          onFinal("最终文字");
        });
      }
      return next;
    });
    const webContents = sender();

    expect((await startAsrTest(webContents as never, () => false)).ok).toBe(true);
    sendAsrTestAudio(webContents as never, new Uint8Array([1, 2]).buffer);
    expect(streams[0].sendAudio).toHaveBeenCalledOnce();
    flushAsrTestPartial(webContents as never);
    expect(streams[0].flush).toHaveBeenCalledOnce();
    expect((await finishAsrTestTurn(webContents as never)).ok).toBe(true);
    expect(streams[0].finish).toHaveBeenCalledOnce();
    expect(streams[1].start).toHaveBeenCalledOnce();
    expect(webContents.sent.some(([, payload]) => (payload as { message?: string }).message?.includes("正在下载 Qwen/Qwen3-ASR-1.7B"))).toBe(true);
    expect(webContents.sent.some(([, payload]) => (payload as { partial?: string }).partial === "实时文字")).toBe(true);
    expect(webContents.sent.some(([, payload]) => (payload as { final?: string }).final === "最终文字")).toBe(true);
  });

  it("has no dependency on reply LLM or TTS modules", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/main/asr/asr-test-manager.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/orchestrator|vendors|tts-dispatcher|runAgent/i);
  });
});
