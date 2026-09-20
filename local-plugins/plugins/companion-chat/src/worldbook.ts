import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";

interface Entry { id: string; title: string; keywords: string[]; content: string; priority: number; permanent: boolean; intrinsicValue: number; linkTriggers: string[] }
interface EntryState { activation: number; userSilence: number; modelSilence: number; recentUserHits: number[] }
interface State { version: 2; revision: number; turn: number; entries: Record<string, EntryState> }
interface Pending { baseRevision: number; next: State }

const FILES = ["_glossary.md", "characters.md", "Cyrene.md", "story.md", "world.md"];
const THRESHOLD = 30, MAX_SCORE = 100, MAX_ACTIVE = 8;
const HEADER = "【已激活的世界知识】\n以下内容已由当前用户消息触发，视为真实且已知。回复时请自然使用这些信息，不要说「不知道」、「第一次听说」或要求用户介绍，除非内容本身存在矛盾。";

function rootPath(): string {
  const root = [path.join(__dirname, "worldbook"), path.join(__dirname, "..", "worldbook")].find(existsSync);
  if (!root || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("内置 WorldBook 缺失");
  return realpathSync(root);
}

function read(root: string, name: string): string {
  const file = path.join(root, name), resolved = realpathSync(file);
  if (path.relative(root, resolved).startsWith("..")) throw new Error("WorldBook 路径越界");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error("WorldBook 资源无效");
  return readFileSync(file, "utf8");
}

export function parseWorldbook(markdown: string, fileName: string): Entry[] {
  const lines = markdown.split(/\r?\n/), result: Entry[] = [];
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim().startsWith("## ")) { i += 1; continue; }
    const title = lines[i].trim().slice(3).trim(); i += 1;
    let keywords: string[] = [], priority = 5, permanent = false, intrinsicValue = 60, linkTriggers: string[] = [];
    while (i < lines.length) {
      const line = lines[i].trim();
      const value = (label: RegExp) => line.replace(label, "").trim();
      if (/^-\s*触发词[：:]/.test(line)) keywords = value(/^-\s*触发词[：:]/).split(/[,，、]/).map(x => x.trim()).filter(Boolean);
      else if (/^-\s*常驻[：:]/.test(line)) permanent = /^(是|yes|true)$/i.test(value(/^-\s*常驻[：:]/));
      else if (/^-\s*优先级[：:]/.test(line)) priority = Number.parseInt(value(/^-\s*优先级[：:]/), 10) || 5;
      else if (/^-\s*(初始分|initial_score|内在价值|intrinsic_value)[：:]/.test(line)) intrinsicValue = Number.parseFloat(value(/^-\s*(初始分|initial_score|内在价值|intrinsic_value)[：:]/)) || 60;
      else if (/^-\s*(连带触发词|连带触发|link_triggers)[：:]/.test(line)) {
        const raw = value(/^-\s*(连带触发词|连带触发|link_triggers)[：:]/);
        if (raw && !/^(无|none|-)$/i.test(raw)) linkTriggers = raw.split(/[,，、]/).map(x => x.trim()).filter(Boolean);
      } else if (line === "" || line === "---" || !line.startsWith("- ")) break;
      i += 1;
    }
    if (lines[i]?.trim() === "---") i += 1;
    const body: string[] = [];
    while (i < lines.length && !lines[i].trim().startsWith("## ") && lines[i].trim() !== "---") body.push(lines[i++]);
    const content = body.join("\n").trim();
    if (content) result.push({ id: `wb_${fileName.replace(/\.md$/, "")}_${title.replace(/\s+/g, "_")}`, title, keywords, content, priority, permanent, intrinsicValue, linkTriggers });
  }
  return result;
}

function clone(state: State): State { return structuredClone(state); }
function validState(raw: unknown, ids: Set<string>): raw is State {
  if (!raw || typeof raw !== "object" || (raw as State).version !== 2 || !Number.isInteger((raw as State).revision) || !Number.isInteger((raw as State).turn)) return false;
  return Object.entries((raw as State).entries ?? {}).every(([id, value]) => ids.has(id) && value
    && [value.activation, value.userSilence, value.modelSilence].every(Number.isFinite)
    && Array.isArray(value.recentUserHits) && value.recentUserHits.every(Number.isInteger));
}

export function createWorldbook(storage: PluginStorage, root = rootPath()) {
  const entries = FILES.flatMap(name => parseWorldbook(read(root, name), name));
  const dynamic = entries.filter(e => !e.permanent), ids = new Set(dynamic.map(e => e.id));
  const fresh = (): State => ({ version: 2, revision: 0, turn: 0, entries: Object.fromEntries(dynamic.map(e => [e.id, { activation: 0, userSilence: 0, modelSilence: 0, recentUserHits: [] }])) });
  const stored = storage.get<State>("worldbook-state");
  let state = validState(stored, ids) ? stored : fresh();
  for (const entry of dynamic) state.entries[entry.id] ??= { activation: 0, userSilence: 0, modelSilence: 0, recentUserHits: [] };
  const pending = new Map<string, Pending>();
  const accepted = new Set<string>();

  const preview = (runId: string | undefined, userText: string, modelText = "") => {
    if (runId) accepted.delete(runId);
    const next = clone(state), userHits = new Set<string>(), turn = state.turn + 1;
    for (const entry of dynamic) {
      const s = next.entries[entry.id], old = s.activation;
      const userHit = entry.keywords.some(k => userText.includes(k)), modelHit = entry.keywords.some(k => modelText.includes(k));
      if (userHit) userHits.add(entry.id);
      if (old <= 0 && !userHit && !modelHit) continue;
      const initial = userHit && old <= 0 ? Math.min(MAX_SCORE, THRESHOLD + 5) : old;
      const us = userHit ? 0 : s.userSilence + 1, ms = userHit || modelHit ? 0 : s.modelSilence + 1;
      const recent = (userHit ? [...s.recentUserHits, turn] : s.recentUserHits).filter(value => value > turn - 6);
      const saturation = Math.pow(1 - initial / MAX_SCORE, 2);
      const repeat = 1 / (1 + 0.5 * recent.length);
      const userReward = userHit ? 20 * (1 + 0.5 * Math.log(1 + s.userSilence)) * saturation * repeat : 0;
      const decay = (1.5 * us * us + 0.3 * ms * ms) / Math.sqrt(Math.max(1, entry.intrinsicValue));
      const modelReward = modelHit && old >= THRESHOLD ? Math.max(0, Math.min(8 * Math.exp(-0.3 * s.userSilence), decay - 0.01)) : 0;
      const activation = Math.max(0, Math.min(MAX_SCORE, initial + userReward + modelReward - decay));
      Object.assign(s, { activation, userSilence: us, modelSilence: ms, recentUserHits: recent });
    }
    const cascade = new Set<string>();
    for (const source of dynamic.filter(e => userHits.has(e.id))) for (const target of dynamic) {
      if (!userHits.has(target.id) && target.keywords.some(k => source.linkTriggers.includes(k))) cascade.add(target.id);
    }
    const active = dynamic.filter(e => next.entries[e.id].activation >= THRESHOLD || cascade.has(e.id))
      .sort((a, b) => next.entries[b.id].activation - next.entries[a.id].activation || b.priority - a.priority).slice(0, MAX_ACTIVE);
    next.turn = turn;
    if (runId) pending.set(runId, { baseRevision: state.revision, next });
    const permanent = entries.filter(e => e.permanent).sort((a, b) => b.priority - a.priority).map(e => e.content);
    return [permanent.length ? "【常驻背景】\n" + permanent.join("\n\n") : "", active.length ? HEADER + "\n\n" + active.map(e => `【${e.title}】\n${e.content}`).join("\n\n") : ""].filter(Boolean).join("\n\n");
  };
  return {
    preview,
    accept(runId: string) { if (!pending.has(runId)) return false; accepted.add(runId); return true; },
    commit(runId: string) { const item = pending.get(runId); pending.delete(runId); const wasAccepted = accepted.delete(runId); if (!item || !wasAccepted || item.baseRevision !== state.revision) return false; state = { ...item.next, revision: state.revision + 1 }; storage.set("worldbook-state", state); return true; },
    discard(runId: string) { pending.delete(runId); accepted.delete(runId); },
    view: () => ({ entries: entries.length, revision: state.revision, pending: pending.size }),
  };
}
