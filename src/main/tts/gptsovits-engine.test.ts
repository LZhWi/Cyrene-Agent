import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { synthesize } from "./gptsovits-engine";

const tempDirs: string[] = [];

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-gsv-test-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, "test");
  return file;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("gptsovits-engine synthesize 输入校验", () => {
  it("缺 baseUrl 时抛错", async () => {
    await expect(synthesize({
      baseUrl: "",
      refAudioPath: "C:/x.wav",
      promptText: "hi",
      text: "hello",
    })).rejects.toThrow(/API 地址/);
  });

  it("缺 refAudioPath 时抛错", async () => {
    await expect(synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath: "",
      promptText: "hi",
      text: "hello",
    })).rejects.toThrow(/参考音频/);
  });

  it("缺 promptText 时抛错", async () => {
    await expect(synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath: "C:/nonexistent.wav",
      promptText: "",
      text: "hello",
    })).rejects.toThrow(/参考音频.*文本|参考文本/);
  });

  it("缺 text 时抛错", async () => {
    await expect(synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath: "C:/nonexistent.wav",
      promptText: "hi",
      text: "",
    })).rejects.toThrow(/合成文本|text/);
  });

  it("把高级推理参数发送到 /tts", async () => {
    const refAudioPath = tempFile("ref.wav");
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      new Response(Buffer.from("RIFFtest"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await synthesize({
      baseUrl: "http://127.0.0.1:19880",
      refAudioPath,
      promptText: "参考文本",
      text: "测试文本",
      textSplitMethod: "cut2",
      topK: 24,
      topP: 0.8,
      temperature: 0.7,
      repetitionPenalty: 1.2,
      sampleSteps: 16,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      text_split_method: "cut2",
      top_k: 24,
      top_p: 0.8,
      temperature: 0.7,
      repetition_penalty: 1.2,
      sample_steps: 16,
    });
  });

  it("相同权重只在首次合成前切换，并与合成串行", async () => {
    const refAudioPath = tempFile("ref.wav");
    const gptWeightsPath = tempFile("voice.ckpt");
    const sovitsWeightsPath = tempFile("voice.pth");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return new Response(String(url).endsWith("/tts") ? Buffer.from("RIFFtest") : "ok", { status: 200 });
    }));
    const request = {
      baseUrl: "http://127.0.0.1:19881",
      refAudioPath,
      promptText: "参考文本",
      text: "测试文本",
      version: "v2Pro" as const,
      gptWeightsPath,
      sovitsWeightsPath,
    };

    await synthesize(request);
    await synthesize(request);

    expect(urls.filter((url) => url.includes("/set_gpt_weights"))).toHaveLength(1);
    expect(urls.filter((url) => url.includes("/set_sovits_weights"))).toHaveLength(1);
    expect(urls.filter((url) => url.endsWith("/tts"))).toHaveLength(2);
    expect(urls[0]).toContain("/set_gpt_weights");
    expect(urls[1]).toContain("/set_sovits_weights");
    expect(urls[2]).toBe("http://127.0.0.1:19881/tts");
  });
});
