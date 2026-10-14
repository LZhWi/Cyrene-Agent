import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { LearnVideo, LearnVideoEntry } from "../../../shared/learn-study";
import { createObsidianWorkspace } from "../obsidian/obsidian-workspace-service";
import { studyPath } from "./study-path";

const DIRECTORY = "notes/videos";
export const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".m4v", ".ogv"]);
function fileFor(id: string) {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("E_LEARN_VIDEO_ID");
  return `${DIRECTORY}/${id}.md`;
}
function parse(content: string): LearnVideo {
  // Identical files in separate Vaults must not share cached mutable entries.
  const data = structuredClone(matter(content).data);
  if (data.schema !== "cyrene-learn-video-v1" || typeof data.id !== "string" || typeof data.file !== "string" || !Array.isArray(data.entries)) throw new Error("E_LEARN_VIDEO_FORMAT");
  if (data.entries.some((entry: LearnVideoEntry) => !entry || !Number.isFinite(entry.seconds) || entry.seconds < 0 || typeof entry.text !== "string")) throw new Error("E_LEARN_VIDEO_FORMAT");
  return { id: data.id, file: data.file, entries: data.entries };
}
export function formatVideoTime(seconds: number): string {
  const value = Math.floor(seconds);
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60].map((part) => String(part).padStart(2, "0")).join(":");
}
function render(video: LearnVideo): string {
  return `---\n${JSON.stringify({ schema: "cyrene-learn-video-v1", ...video }, null, 2)}\n---\n\n# 视频时间轴笔记\n\n视频：${video.file}\n\n` + video.entries.map((entry) => `## ${formatVideoTime(entry.seconds)} · ${entry.kind === "subtitle" ? "字幕" : "笔记"}\n\n${entry.text}\n`).join("\n");
}
export function parseSubtitles(content: string): LearnVideoEntry[] {
  const entries: LearnVideoEntry[] = [];
  for (const block of content.replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const index = lines.findIndex((line) => line.includes("-->"));
    if (index < 0) continue;
    const match = lines[index].match(/^(?:(\d{2,}):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->/);
    if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) throw new Error("E_LEARN_SUBTITLE_TIME");
    const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
    const text = lines.slice(index + 1).join("\n").trim();
    if (!text) continue;
    entries.push({ id: createHash("sha256").update(`${seconds}:${text}`).digest("hex"), seconds, text, kind: "subtitle" });
  }
  if (!entries.length) throw new Error("没有找到有效的 SRT/VTT 字幕条目");
  return entries;
}
export class LearnVideoService {
  private readonly vault;
  constructor(private readonly root: string) { this.vault = createObsidianWorkspace(root); }
  resolve(file: string): string {
    const resolved = studyPath(this.root, file);
    if (!VIDEO_EXTENSIONS.has(path.extname(resolved).toLowerCase()) || !fs.statSync(resolved).isFile()) throw new Error("E_LEARN_VIDEO_FILE");
    return resolved;
  }
  async list(): Promise<LearnVideo[]> {
    studyPath(this.root, DIRECTORY);
    if (!fs.existsSync(path.join(this.root, DIRECTORY))) return [];
    const files = await this.vault.listFiles({ relativeDir: DIRECTORY, recursive: false });
    const videos: LearnVideo[] = [];
    for (const file of files) {
      if (!/^[0-9a-f]{64}\.md$/.test(path.basename(file.path))) continue;
      const video = parse((await this.vault.readFile({ path: file.path })).content);
      if (file.path !== fileFor(video.id)) throw new Error("E_LEARN_VIDEO_ID");
      videos.push(video);
    }
    return videos;
  }
  async add(file: string): Promise<LearnVideo> {
    this.resolve(file);
    const normalized = path.normalize(file).replace(/\\/g, "/");
    const id = createHash("sha256").update(normalized).digest("hex");
    let video!: LearnVideo;
    studyPath(this.root, fileFor(id));
    await this.vault.updateFile({ path: fileFor(id), update: (content) => {
      video = content === undefined ? { id, file: normalized, entries: [] } : parse(content);
      if (video.id !== id || video.file !== normalized) throw new Error("E_LEARN_VIDEO_ID");
      return render(video);
    } });
    return video;
  }
  async addEntries(id: string, entries: LearnVideoEntry[]): Promise<void> {
    studyPath(this.root, fileFor(id));
    await this.vault.updateFile({ path: fileFor(id), update: (content) => {
      if (content === undefined) throw new Error("E_LEARN_VIDEO_NOT_FOUND");
      const video = parse(content);
      if (video.id !== id) throw new Error("E_LEARN_VIDEO_ID");
      for (const entry of entries) if (!video.entries.some((value) => value.id === entry.id)) video.entries.push(entry);
      video.entries.sort((a, b) => a.seconds - b.seconds);
      return render(video);
    } });
  }
  async addNote(id: string, seconds: number, text: string): Promise<void> {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 8640000 || typeof text !== "string" || !text.trim() || text.length > 20000) throw new Error("E_LEARN_VIDEO_NOTE");
    await this.addEntries(id, [{ id: randomUUID(), seconds, text: text.trim(), kind: "note" }]);
  }
}
