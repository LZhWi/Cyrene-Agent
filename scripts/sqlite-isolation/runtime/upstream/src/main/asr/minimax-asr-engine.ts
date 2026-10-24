import { resolveTimeoutPolicy } from "../runtime-policy";
import { encodePcm16MonoWav } from "./mossland-asr-engine";

const MINIMAX_ASR_URL = "https://api.minimax.cn/v1/speech_to_text";

async function transcribeWav(apiKey: string, wav: Buffer): Promise<string> {
  const form = new FormData();
  form.append("model", "asr-1.0");
  form.append("response_format", "json");
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    resolveTimeoutPolicy({ stage: "asr-minimax" }).totalMs,
  );
  let response: Response;
  try {
    response = await fetch(MINIMAX_ASR_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("MiniMax 转写失败：请求超时，请稍后重试");
    }
    throw new Error(`MiniMax 转写失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const rawBody = await response.text();
    let detail = rawBody.slice(0, 200);
    try {
      const body = JSON.parse(rawBody) as { error?: { message?: unknown }; message?: unknown };
      const message = body.error?.message ?? body.message;
      if (typeof message === "string" && message.trim()) detail = message.trim();
    } catch {
      // Keep a short response excerpt when the provider does not return JSON.
    }
    throw new Error(`MiniMax 转写失败：HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
  }

  const data = await response.json() as { text?: unknown };
  if (typeof data.text !== "string") {
    throw new Error("MiniMax 转写失败：服务端未返回 text");
  }
  return data.text.trim();
}

/** MiniMax 整段转写会话：缓存一轮 PCM，stop 时上传 WAV 并返回完整文本。 */
export class MiniMaxAsrStream {
  private readonly frames: Buffer[] = [];
  private stopPromise: Promise<string> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly onFinal: (text: string) => void,
  ) {}

  async start(): Promise<void> {
    if (!this.apiKey.trim()) {
      throw new Error("MiniMax 转写失败：缺少 API Key");
    }
  }

  sendAudio(pcmFrame: Buffer): void {
    if (this.stopPromise || pcmFrame.length === 0) return;
    this.frames.push(Buffer.from(pcmFrame));
  }

  stop(): Promise<string> {
    if (!this.stopPromise) this.stopPromise = this.finish();
    return this.stopPromise;
  }

  private async finish(): Promise<string> {
    if (this.frames.length === 0) return "";
    const pcm = Buffer.concat(this.frames);
    if (pcm.length > 16_000 * 2 * 500) {
      throw new Error("MiniMax 转写失败：音频时长超过 500 秒限制");
    }
    const wav = encodePcm16MonoWav(pcm);
    if (wav.length > 50 * 1024 * 1024) {
      throw new Error("MiniMax 转写失败：音频文件超过 50 MB 限制");
    }
    const text = await transcribeWav(this.apiKey, wav);
    if (text) this.onFinal(text);
    return text;
  }
}
