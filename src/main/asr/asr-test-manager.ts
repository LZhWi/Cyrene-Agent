import { ipcMain, type WebContents } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createAsrStream, shutdownAsrRuntimes, type AsrStream } from "./asr-factory";
import { getAsrConfig, type AsrConfig } from "./volcano-asr-engine";

export type AsrTestState = "loading" | "listening" | "finalizing" | "error" | "stopped";

let stream: AsrStream | null = null;
let owner: WebContents | null = null;
let config: AsrConfig | null = null;
let state: AsrTestState = "stopped";
let generation = 0;

function send(channel: string, payload: unknown): void {
  if (!owner || owner.isDestroyed()) return;
  owner.send(channel, payload);
}

function setState(next: AsrTestState, message?: string): void {
  state = next;
  send(IPC.ASR_TEST_STATE, { state: next, message });
}

function validateConfig(value: AsrConfig | null): AsrConfig {
  if (!value || value.engine === "off") throw new Error("请先选择语音识别引擎");
  if (value.engine === "aliyun" && (!value.appKey || !value.accessKeyId || !value.accessKeySecret)) {
    throw new Error("阿里云 ASR 配置不完整");
  }
  return value;
}

async function createStream(expectedGeneration: number): Promise<void> {
  if (!config || expectedGeneration !== generation) return;
  const next = createAsrStream(
    config,
    (partial) => send(IPC.ASR_TEST_RESULT, { partial }),
    (final) => send(IPC.ASR_TEST_RESULT, { final }),
    ({ phase, model }) => {
      if (expectedGeneration !== generation) return;
      const label = model || "ASR 模型";
      setState("loading", phase === "downloading"
        ? `首次使用，正在下载 ${label}…`
        : `下载已完成，正在加载 ${label}…`);
    },
  );
  stream = next;
  await next.start();
  if (expectedGeneration !== generation) {
    next.stop();
    return;
  }
  setState("listening");
}

export function isAsrTestActive(): boolean {
  return state !== "stopped";
}

export async function startAsrTest(sender: WebContents, isCallActive: () => boolean): Promise<{ ok: boolean; error?: string }> {
  if (isCallActive()) return { ok: false, error: "语音通话正在进行，请先结束通话" };
  stopAsrTest();
  owner = sender;
  sender.once("destroyed", () => {
    if (owner === sender) stopAsrTest();
  });
  const currentGeneration = ++generation;
  try {
    config = validateConfig(getAsrConfig());
    setState("loading");
    await createStream(currentGeneration);
    return currentGeneration === generation
      ? { ok: true }
      : { ok: false, error: "测试已停止" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(IPC.ASR_TEST_ERROR, { message });
    setState("error");
    stream?.stop();
    stream = null;
    config = null;
    return { ok: false, error: message };
  }
}

export function sendAsrTestAudio(sender: WebContents, frame: ArrayBuffer): void {
  if (sender !== owner || state !== "listening" || !stream) return;
  stream.sendAudio(Buffer.from(frame));
}

export function flushAsrTestPartial(sender: WebContents): void {
  if (sender !== owner || state !== "listening") return;
  stream?.flush?.();
}

export async function finishAsrTestTurn(sender: WebContents): Promise<{ ok: boolean; error?: string }> {
  if (sender !== owner || state !== "listening" || !stream) return { ok: false, error: "ASR 测试未在监听" };
  const currentGeneration = generation;
  const finishing = stream;
  stream = null;
  setState("finalizing");
  try {
    await finishing.finish();
    if (currentGeneration === generation) await createStream(currentGeneration);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(IPC.ASR_TEST_ERROR, { message });
    if (currentGeneration === generation) {
      try {
        await createStream(currentGeneration);
      } catch {
        setState("error");
      }
    }
    return { ok: false, error: message };
  }
}

export function stopAsrTest(sender?: WebContents): void {
  if (sender && sender !== owner) return;
  generation += 1;
  stream?.stop();
  stream = null;
  config = null;
  if (owner && !owner.isDestroyed()) setState("stopped");
  else state = "stopped";
  owner = null;
  shutdownAsrRuntimes();
}

export function registerAsrTestIpc(isCallActive: () => boolean): void {
  ipcMain.handle(IPC.ASR_TEST_START, (event) => startAsrTest(event.sender, isCallActive));
  ipcMain.on(IPC.ASR_TEST_AUDIO_FRAME, (event, frame: ArrayBuffer) => sendAsrTestAudio(event.sender, frame));
  ipcMain.on(IPC.ASR_TEST_FLUSH, (event) => flushAsrTestPartial(event.sender));
  ipcMain.handle(IPC.ASR_TEST_TURN_END, (event) => finishAsrTestTurn(event.sender));
  ipcMain.handle(IPC.ASR_TEST_STOP, (event) => {
    stopAsrTest(event.sender);
    return true;
  });
}
