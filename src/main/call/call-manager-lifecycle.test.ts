import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

const mocks = vi.hoisted(() => ({
  createAsrStream: vi.fn(),
  getAsrConfig: vi.fn(),
  synthesizeByEngine: vi.fn(),
  enqueueLLMTask: vi.fn(async () => undefined),
}));

vi.mock("electron", () => ({ BrowserWindow: class {}, ipcMain: { on: vi.fn() } }));
vi.mock("../asr/asr-factory", () => ({
  createAsrStream: mocks.createAsrStream,
  shutdownAsrRuntimes: vi.fn(),
}));
vi.mock("../asr/volcano-asr-engine", () => ({ getAsrConfig: mocks.getAsrConfig }));
vi.mock("../asr/asr-test-manager", () => ({ isAsrTestActive: () => false }));
vi.mock("../tts/tts-dispatcher", () => ({ synthesizeByEngine: mocks.synthesizeByEngine }));
vi.mock("../llm-queue", () => ({ enqueueLLMTask: mocks.enqueueLLMTask }));
vi.mock("./call-context-store", () => ({ saveCallContextEvent: vi.fn() }));
vi.mock("../orchestrator/tool-registry", () => ({ toolRegistry: { getById: () => undefined } }));
vi.mock("../orchestrator/vendors", () => ({
  buildVendorUrl: () => "https://model.example.test/chat",
  getAdapterForConfig: () => ({
    transport: "openai",
    buildRequest: () => ({ headers: {}, body: "{}" }),
    parseResponse: () => ({ text: "语音回复" }),
  }),
}));

import { endTurn, setCallSettings, setCallWindow, startCall, stopCall } from "./call-manager";

const asrConfig = {
  engine: "local", appKey: "", accessKeyId: "", accessKeySecret: "",
  language: "zh", localProfile: "paraformer-qwen17", hotwords: [],
};

const ttsSettings = {
  ttsEngine: "custom-cloud" as const,
  ttsMinimaxKey: "", ttsMinimaxVoiceId: "", ttsMinimaxModel: "speech-2.8-turbo" as const,
  ttsSpeed: 1, ttsVolume: 1,
  ttsGptsovitsBaseUrl: "", ttsGptsovitsRefAudioPath: "", ttsGptsovitsPromptText: "",
  ttsGptsovitsFormat: "wav" as const, ttsGptsovitsVersion: "auto" as const,
  ttsGptsovitsGptWeightsPath: "", ttsGptsovitsSovitsWeightsPath: "",
  ttsGptsovitsTextSplitMethod: "cut5" as const, ttsGptsovitsTopK: 15,
  ttsGptsovitsTopP: 1, ttsGptsovitsTemperature: 1,
  ttsGptsovitsRepetitionPenalty: 1.35, ttsGptsovitsSampleSteps: 32,
  ttsCustomCloudEndpointUrl: "https://tts.example.test", ttsCustomCloudApiKey: "",
  ttsCustomCloudVoiceId: "", ttsCustomCloudFormat: "mp3" as const, ttsCustomCloudTimeoutMs: 30_000,
  ttsMimoKey: "", ttsMimoVoiceAudioPath: "", ttsMimoStylePrompt: "",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("call lifecycle", () => {
  const sent: Array<[string, unknown]> = [];

  beforeEach(() => {
    sent.length = 0;
    mocks.createAsrStream.mockReset();
    mocks.synthesizeByEngine.mockReset();
    mocks.getAsrConfig.mockReturnValue(asrConfig);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    setCallWindow({
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => sent.push([channel, payload]) },
    } as never);
    setCallSettings(
      () => ({ provider: "test", baseUrl: "https://model.example.test", model: "model", apiKey: "key" }),
      () => ttsSettings,
      async () => ({ system: "" }),
    );
  });

  afterEach(() => {
    stopCall();
    setCallWindow(null);
    vi.unstubAllGlobals();
  });

  it("enters LISTENING only after the ASR stream is ready", async () => {
    const ready = deferred<void>();
    mocks.createAsrStream.mockReturnValue({
      start: () => ready.promise, sendAudio: vi.fn(), finish: vi.fn(), stop: vi.fn(),
    });
    const starting = startCall();
    await Promise.resolve();
    expect(sent.some(([channel, payload]) => channel === IPC.CALL_STATE && (payload as { state: string }).state === "LISTENING")).toBe(false);

    ready.resolve();
    await starting;
    expect(sent.some(([channel, payload]) => channel === IPC.CALL_STATE && (payload as { state: string }).state === "LISTENING")).toBe(true);
  });

  it("drops a pending TTS result after hangup", async () => {
    let onFinal: ((text: string) => void) | undefined;
    mocks.createAsrStream.mockImplementation((_cfg, _partial, final) => {
      onFinal = final;
      return { start: vi.fn(async () => {}), sendAudio: vi.fn(), finish: vi.fn(async () => {}), stop: vi.fn() };
    });
    const tts = deferred<{ audio: Buffer; format: "mp3" }>();
    mocks.synthesizeByEngine.mockReturnValue(tts.promise);

    await startCall();
    onFinal?.("测试问题");
    const turn = endTurn();
    await vi.waitFor(() => expect(mocks.synthesizeByEngine).toHaveBeenCalledOnce());
    const signal = mocks.synthesizeByEngine.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    stopCall();
    expect(signal.aborted).toBe(true);
    tts.resolve({ audio: Buffer.from("audio"), format: "mp3" });
    await turn;

    expect(sent.some(([channel]) => channel === IPC.CALL_TTS_AUDIO)).toBe(false);
    expect(sent.at(-1)).toEqual([IPC.CALL_STATE, { state: "ENDED" }]);
  });

  it("preserves the synthesized audio format in the renderer event", async () => {
    let onFinal: ((text: string) => void) | undefined;
    mocks.createAsrStream.mockImplementation((_cfg, _partial, final) => {
      onFinal = final;
      return { start: vi.fn(async () => {}), sendAudio: vi.fn(), finish: vi.fn(async () => {}), stop: vi.fn() };
    });
    mocks.synthesizeByEngine.mockResolvedValue({ audio: Buffer.from("RIFFaudio"), format: "wav" });

    await startCall();
    onFinal?.("测试问题");
    await endTurn();

    expect(sent).toContainEqual([IPC.CALL_TTS_AUDIO, {
      base64: Buffer.from("RIFFaudio").toString("base64"),
      format: "wav",
    }]);
  });
});
