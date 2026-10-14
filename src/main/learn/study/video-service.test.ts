import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LearnVideoService, parseSubtitles } from "./video-service";
import { videoResponse } from "./video-response";
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "learn-video-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
describe("Vault video timeline", () => {
  it("imports SRT and VTT times without interpreting subtitle markup", () => {
    expect(parseSubtitles("1\r\n00:01:02,500 --> 00:01:03,000\r\n<script>文字</script>\r\n")[0]).toMatchObject({ seconds: 62.5, text: "<script>文字</script>", kind: "subtitle" });
    expect(parseSubtitles("WEBVTT\n\n00:02.250 --> 00:03.000\n第二秒")[0].seconds).toBe(2.25);
    expect(() => parseSubtitles("not subtitles")).toThrow("没有找到");
    expect(() => parseSubtitles("00:99:12,000 --> 00:99:15,000\nx")).toThrow("TIME");
  });
  it("merges concurrent notes, deduplicates subtitle imports and retains original files", async () => {
    fs.writeFileSync(path.join(root, "course.mp4"), "synthetic video");
    const service = new LearnVideoService(root); const video = await service.add("course.mp4");
    await Promise.all(Array.from({ length: 10 }, (_, index) => new LearnVideoService(root).addNote(video.id, index, `笔记${index}`)));
    const entries = parseSubtitles("1\n00:00:02,000 --> 00:00:03,000\n字幕\n");
    await Promise.all([service.addEntries(video.id, entries), service.addEntries(video.id, entries)]);
    const list = await service.list(); expect(list).toHaveLength(1); expect(list[0].entries).toHaveLength(11);
    expect(list[0].entries.map((entry) => entry.seconds)).toEqual([...list[0].entries.map((entry) => entry.seconds)].sort((a, b) => a - b));
    expect(fs.readFileSync(path.join(root, "course.mp4"), "utf8")).toBe("synthetic video");
    expect(await new LearnVideoService(root).add("./course.mp4")).toMatchObject({ id: video.id });
  });
  it("restricts selected media and generated files to the Vault", async () => {
    const service = new LearnVideoService(root);
    await expect(service.add("../secret.mp4")).rejects.toThrow("PATH");
    fs.writeFileSync(path.join(root, "secret.txt"), "x"); await expect(service.add("secret.txt")).rejects.toThrow("FILE");
    await expect(service.addNote("../escape", 0, "text")).rejects.toThrow("ID");
    await expect(service.addNote("a".repeat(64), NaN, "text")).rejects.toThrow("NOTE");
    expect(fs.existsSync(path.join(root, "notes"))).toBe(false);
  });
  it("streams exact byte ranges for player seeking and rejects invalid ranges", async () => {
    const file = path.join(root, "course.mp4"); fs.writeFileSync(file, "0123456789");
    const response = await videoResponse(file, new Request("https://test/video", { headers: { Range: "bytes=2-5" } }));
    expect(response.status).toBe(206); expect(response.headers.get("content-range")).toBe("bytes 2-5/10"); expect(await response.text()).toBe("2345");
    expect(await (await videoResponse(file, new Request("https://test/video", { headers: { Range: "bytes=-3" } }))).text()).toBe("789");
    expect((await videoResponse(file, new Request("https://test/video", { headers: { Range: "bytes=15-20" } }))).status).toBe(416);
    expect((await videoResponse(file, new Request("https://test/video", { method: "HEAD" }))).headers.get("content-length")).toBe("10");
  });
});
