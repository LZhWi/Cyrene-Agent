import * as fs from "fs";
import * as path from "path";
import { Worker } from "worker_threads";
import { WorldbookManager } from "../../rag/worldbook";
import { loadMinecraftSessionEvents } from "./session-store";

export interface MinecraftChatTurn {
  role: "user" | "assistant" | "other";
  name?: string;
  content: string;
  at?: number;
}

export interface MinecraftSoulContextRequest {
  query: string;
  gameConversation?: MinecraftChatTurn[];
  gameSummary?: string;
}

export interface MinecraftSoulContext {
  version: 2;
  source: "gamebot_readonly_snapshot";
  entryPersona: string;
  exitPersona: string;
  exitExpressionRules: string;
  conversation: Array<{ role: "user" | "assistant"; content: string; at?: number }>;
  memories: string[];
  gameConversation: MinecraftChatTurn[];
  gameSummary: string;
  worldbook: string[];
  /** 最近 1-2 条已保存的联机记录摘要（档案只有历史会话，不含当前进行中的这局）。 */
  recentSessions: Array<{
    startedAt: number;
    endedAt: number;
    serverLabel: string;
    players: string[];
    summary: string;
  }>;
}

interface RetrievalResult {
  conversation: MinecraftSoulContext["conversation"];
  memories: string[];
}

const ENTRY_SOUL_SECTIONS = [
  "存在与对话定位", "一、你是谁", "二、性格核心", "三、你爱的方式",
  "情绪真实性", "独立判断", "情绪连续性", "五、禁忌",
];
const EXIT_SOUL_STOP = new Set(["六、外貌描述", "Live2D 与聊天文字的分工"]);
const EXIT_SYSTEM_SECTIONS = new Set([
  "基本设定", "回复长度", "即时聊天表达方式", "事实边界", "严禁行为", "语言禁忌",
]);

function readText(file: string): string {
  try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : ""; }
  catch { return ""; }
}

function splitH2(markdown: string): Array<{ title: string; body: string }> {
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  return matches.map((match, index) => ({
    title: match[1].trim(),
    body: markdown.slice(match.index!, matches[index + 1]?.index ?? markdown.length).trim(),
  }));
}

function projectSoul(markdown: string, mode: "entry" | "exit"): string {
  const intro = markdown.split(/^##\s+/m)[0].trim();
  const sections = splitH2(markdown);
  const selected = mode === "entry"
    ? sections.filter((section) => ENTRY_SOUL_SECTIONS.includes(section.title))
    : sections.filter((section) => !EXIT_SOUL_STOP.has(section.title));
  return [intro, ...selected.map((section) => section.body)].filter(Boolean).join("\n\n");
}

function projectSystem(markdown: string): string {
  const intro = markdown.split(/^##\s+/m)[0].trim();
  return [intro, ...splitH2(markdown)
    .filter((section) => EXIT_SYSTEM_SECTIONS.has(section.title))
    .map((section) => section.body.replace(
      /^###\s+Live2D[^\n]*\n[\s\S]*?(?=^###\s+|(?![\s\S]))/gm,
      "",
    ).trim())]
    .filter(Boolean).join("\n\n");
}

function projectTone(markdown: string): string {
  return markdown.split(/\r?\n/)
    .filter((line) => !line.includes("[你的生活]") && !line.includes("天气工具") && !line.includes("其他城市"))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function buildMinecraftPersonaViews(appPath: string): { entryPersona: string; exitPersona: string; exitExpressionRules: string } {
  const promptDir = path.join(appPath, "prompts");
  const soul = readText(path.join(promptDir, "soul.md"));
  const style = readText(path.join(promptDir, "styles", "01_default.md"));
  const system = readText(path.join(promptDir, "system.md"));
  const tone = readText(path.join(promptDir, "tone-rules.md"));
  return {
    entryPersona: projectSoul(soul, "entry").slice(0, 14_000),
    exitPersona: projectSoul(soul, "exit").slice(0, 20_000),
    exitExpressionRules: [projectSystem(system), style, projectTone(tone)]
      .filter(Boolean).join("\n\n---\n\n").slice(0, 16_000),
  };
}

function resolveWorker(appPath: string): string | null {
  const candidates = [
    path.join(appPath, "src", "main", "game-bot", "minecraft-sidecar", "context-retrieval-worker.cjs"),
    path.join(process.resourcesPath ?? "", "game-bot", "minecraft-sidecar", "context-retrieval-worker.cjs"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

const retrievalCache = new Map<string, { expiresAt: number; value: RetrievalResult }>();

async function retrieveReadOnly(appPath: string, userData: string, query: string): Promise<RetrievalResult> {
  const cacheKey = `${userData}\n${query.trim().toLowerCase()}`;
  const cached = retrievalCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const workerFile = resolveWorker(appPath);
  if (!workerFile) return { conversation: [], memories: [] };
  const value = await new Promise<RetrievalResult>((resolve) => {
    const worker = new Worker(workerFile, { workerData: { userData, query } });
    const timer = setTimeout(() => { void worker.terminate(); resolve({ conversation: [], memories: [] }); }, 1_500);
    worker.once("message", (result) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(result && typeof result === "object" ? result as RetrievalResult : { conversation: [], memories: [] });
    });
    worker.once("error", () => { clearTimeout(timer); void worker.terminate(); resolve({ conversation: [], memories: [] }); });
  });
  retrievalCache.set(cacheKey, { expiresAt: Date.now() + 60_000, value });
  if (retrievalCache.size > 30) retrievalCache.delete(retrievalCache.keys().next().value as string);
  return value;
}

const worldbooks = new Map<string, Promise<WorldbookManager>>();

function loadGameWorldbookState(manager: WorldbookManager, file: string): void {
  try {
    const values = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { activation?: unknown; userSilence?: unknown; modelSilence?: unknown }>;
    for (const [id, value] of Object.entries(values)) {
      const state = manager.getState(id);
      if (!state || !value || typeof value !== "object") continue;
      state.activation = Math.max(0, Math.min(100, Number(value.activation) || 0));
      state.userSilence = Math.max(0, Math.trunc(Number(value.userSilence) || 0));
      state.modelSilence = Math.max(0, Math.trunc(Number(value.modelSilence) || 0));
    }
  } catch { /* first run or invalid GameBot-only state */ }
}

function saveGameWorldbookState(manager: WorldbookManager, file: string): void {
  try {
    const values = Object.fromEntries(manager.getEntries().flatMap((entry) => {
      const state = manager.getState(entry.id);
      return state ? [[entry.id, { ...state }]] : [];
    }));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(values), "utf8");
    fs.renameSync(temp, file);
  } catch { /* Worldbook context remains usable in-memory */ }
}

async function retrieveWorldbook(appPath: string, userData: string, request: MinecraftSoulContextRequest): Promise<string[]> {
  const key = `${appPath}\n${userData}`;
  let managerPromise = worldbooks.get(key);
  if (!managerPromise) {
    const stateFile = path.join(userData, "game-bot", "minecraft-worldbook-state.json");
    const manager = new WorldbookManager(path.join(appPath, "prompts", "worldbook"), {
      debug: false,
    });
    managerPromise = manager.loadFromDirectory().then(() => {
      loadGameWorldbookState(manager, stateFile);
      return manager;
    });
    worldbooks.set(key, managerPromise);
  }
  try {
    const manager = await managerPromise;
    const previousAssistant = [...(request.gameConversation ?? [])].reverse()
      .find((turn) => turn.role === "assistant")?.content ?? "";
    manager.updateActivation(request.query, previousAssistant);
    saveGameWorldbookState(manager, path.join(userData, "game-bot", "minecraft-worldbook-state.json"));
    const permanent = manager.getPermanentEntries();
    const active = manager.getActiveEntries();
    const cascade = manager.getCascadeEntries().map((entry) => entry.content);
    return [...permanent, ...active, ...cascade].slice(0, 8);
  } catch {
    worldbooks.delete(key);
    return [];
  }
}

export async function buildMinecraftSoulContext(
  appPath: string,
  userData: string,
  input: string | MinecraftSoulContextRequest,
): Promise<MinecraftSoulContext> {
  const request: MinecraftSoulContextRequest = typeof input === "string" ? { query: input } : input;
  const [retrieved, worldbook] = await Promise.all([
    retrieveReadOnly(appPath, userData, request.query),
    retrieveWorldbook(appPath, userData, request),
  ]);
  const persona = buildMinecraftPersonaViews(appPath);
  // 最近已保存的联机记录：让 Soul 在意图理解/自主目标时记得此前联机发生过什么。
  let recentSessions: MinecraftSoulContext["recentSessions"] = [];
  try {
    recentSessions = loadMinecraftSessionEvents(path.join(userData, "game-bot", "minecraft-sessions.json"))
      .slice(-2)
      .map((session) => ({
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        serverLabel: session.serverLabel,
        players: session.players,
        summary: session.summary.slice(0, 400),
      }));
  } catch { /* 档案读取失败不阻断上下文构建 */ }
  return {
    version: 2,
    source: "gamebot_readonly_snapshot",
    ...persona,
    conversation: retrieved.conversation.slice(0, 5),
    memories: retrieved.memories.slice(0, 5),
    gameConversation: (request.gameConversation ?? []).slice(-20).map((turn) => ({
      role: turn.role,
      ...(turn.name ? { name: String(turn.name).slice(0, 32) } : {}),
      content: String(turn.content).replace(/\s+/g, " ").trim().slice(0, 600),
      ...(Number.isFinite(turn.at) ? { at: turn.at } : {}),
    })).filter((turn) => turn.content),
    gameSummary: String(request.gameSummary ?? "").trim().slice(0, 2400),
    worldbook,
    recentSessions,
  };
}
