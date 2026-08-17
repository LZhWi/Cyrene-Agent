import { fork, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { MinecraftBotSettings, MinecraftSessionEvent } from "./types";
import { saveMinecraftSessionEvent } from "./session-store";
import { saveMinecraftLlmReport } from "./llm-report-store";
import { buildMinecraftSoulContext, type MinecraftChatTurn } from "./soul-context";
import { MinecraftThirdPersonCapture, type MinecraftCameraAnchor } from "./vision-capture";
import { focusMinecraftThirdPerson, observeMinecraftThirdPerson } from "./vision";
import type { VlmConfig } from "../vlm-locator";

export type MinecraftManagerEvent =
  | { type: "progress"; description: string }
  | { type: "summary-review"; stage: "offer" | "draft"; id: string; summary?: string };
type Progress = (event: MinecraftManagerEvent) => void;

interface SidecarMessage {
  type?: string;
  message?: string;
  startedAt?: number;
  endedAt?: number;
  serverLabel?: string;
  players?: string[];
  durationMinutes?: number;
  highlights?: string[];
  conversationSummary?: string;
  recentConversation?: unknown[];
  fallbackSummary?: string;
  report?: unknown;
  requestId?: string;
  request?: string;
  gameConversation?: MinecraftChatTurn[];
  gameSummary?: string;
  viewerUrl?: string;
  structuredWorld?: unknown;
  focus?: string;
}

interface SessionDraft {
  id: string;
  startedAt: number;
  endedAt: number;
  serverLabel: string;
  players: string[];
  durationMinutes: number;
  highlights: string[];
  conversationSummary: string;
  recentConversation: unknown[];
  fallbackSummary: string;
  generatedSummary?: string;
}

function cameraAnchorFromWorld(world: unknown): MinecraftCameraAnchor | null {
  if (!world || typeof world !== "object" || !("position" in world)) return null;
  const position = (world as { position?: unknown }).position;
  if (!position || typeof position !== "object") return null;
  const value = position as Partial<MinecraftCameraAnchor>;
  return [value.x, value.y, value.z].every(Number.isFinite)
    ? { x: Number(value.x), y: Number(value.y), z: Number(value.z) }
    : null;
}

export function resolveMinecraftSidecar(appPath: string, resourcesPath: string): string | null {
  const candidates = [
    path.join(appPath, "src", "main", "game-bot", "minecraft-sidecar", "sidecar.cjs"),
    path.join(resourcesPath, "game-bot", "minecraft-sidecar", "sidecar.cjs"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export class MinecraftBotManager {
  private child: ChildProcess | null = null;
  private pendingSummary: SessionDraft | null = null;
  private progress: Progress | null = null;
  private sessionFile = "";
  private soulSettings: (MinecraftBotSettings["soul"] & { cacheSessionId?: string }) | null = null;
  private sidecarDir = "";
  private viewerUrl = "";
  private visionConfig: VlmConfig | null = null;
  private visionCapture = new MinecraftThirdPersonCapture();
  private sessionSaved: ((event: MinecraftSessionEvent) => void) | null = null;

  get running(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  /** 联机记录经用户确认保存后的回调（主 app 用它往聊天会话插联机气泡，对齐通话结束回调）。 */
  setSessionSavedCallback(callback: ((event: MinecraftSessionEvent) => void) | null): void {
    this.sessionSaved = callback;
  }

  getPendingSummaryReview(): MinecraftManagerEvent | null {
    const draft = this.pendingSummary;
    if (!draft) return null;
    return draft.generatedSummary
      ? { type: "summary-review", stage: "draft", id: draft.id, summary: draft.generatedSummary }
      : { type: "summary-review", stage: "offer", id: draft.id };
  }

  start(appPath: string, userData: string, settings: MinecraftBotSettings, visionConfig: VlmConfig | null, progress: Progress, onExit: () => void): void {
    if (this.running) throw new Error("Minecraft 玩家已经在线或正在连接");
    const script = resolveMinecraftSidecar(appPath, process.resourcesPath);
    if (!script) throw new Error("找不到 Minecraft sidecar 运行文件，请重新安装包含 GameBot 资源的应用版本");
    const mineflayer = path.join(path.dirname(script), "node_modules", "mineflayer", "package.json");
    if (!fs.existsSync(mineflayer)) throw new Error("Minecraft sidecar 依赖尚未安装，请在 minecraft-sidecar 目录运行 npm.cmd install");
    const child = fork(script, [], {
      cwd: path.dirname(script),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    this.child = child;
    this.progress = progress;
    this.sessionFile = path.join(userData, "game-bot", "minecraft-sessions.json");
    this.soulSettings = { ...settings.soul, cacheSessionId: randomUUID() };
    this.sidecarDir = path.dirname(script);
    this.visionConfig = visionConfig;
    child.stdout?.on("data", (data) => progress({ type: "progress", description: String(data).trim() }));
    child.stderr?.on("data", (data) => progress({ type: "progress", description: "Minecraft: " + String(data).trim() }));
    child.on("message", (raw) => {
      const msg = raw as SidecarMessage;
      if (msg.type === "progress" && msg.message) progress({ type: "progress", description: msg.message });
      if (msg.type === "viewer_ready" && msg.viewerUrl) this.viewerUrl = msg.viewerUrl;
      if (msg.type === "vision_request" && msg.requestId) {
        const config = this.visionConfig;
        const url = this.viewerUrl;
        const respond = (observation: unknown): void => {
          if (this.child === child && child.connected) child.send({ type: "vision_response", requestId: msg.requestId, observation });
        };
        if (!config || !url) {
          respond(null);
        } else {
          void this.visionCapture.capture(url, cameraAnchorFromWorld(msg.structuredWorld))
            .then(async (image): Promise<string | import("./vision").MinecraftVisionObservation> => {
              if (msg.focus) return focusMinecraftThirdPerson(config, image, msg.focus, msg.structuredWorld);
              return observeMinecraftThirdPerson(config, image, msg.structuredWorld);
            })
            .then((observation) => respond(observation))
            .catch((error) => {
              progress({ type: "progress", description: `Minecraft 第三视角暂不可用，已降级为结构化感知：${error instanceof Error ? error.message : String(error)}` });
              respond(null);
            });
        }
      }
      if (msg.type === "session_draft" && msg.startedAt && msg.endedAt && msg.fallbackSummary) {
        this.pendingSummary = {
          id: randomUUID(),
          startedAt: msg.startedAt,
          endedAt: msg.endedAt,
          serverLabel: msg.serverLabel ?? `${settings.host}:${settings.port}`,
          players: msg.players ?? [],
          durationMinutes: Math.max(1, Number(msg.durationMinutes) || 1),
          highlights: (msg.highlights ?? []).slice(-30),
          conversationSummary: String(msg.conversationSummary ?? "").slice(0, 2400),
          recentConversation: (msg.recentConversation ?? []).slice(-30),
          fallbackSummary: msg.fallbackSummary,
        };
        progress({ type: "summary-review", stage: "offer", id: this.pendingSummary.id });
      }
      if (msg.type === "llm_task_report" && msg.report) {
        const saved = saveMinecraftLlmReport(path.join(userData, "game-bot", "minecraft-llm-reports.json"), msg.report);
        if (saved) progress({ type: "progress", description: `Minecraft 自然语言任务已记录：${saved.status}` });
      }
      if (msg.type === "soul_context_request" && msg.requestId && msg.request) {
        const respondContext = (context: unknown): void => {
          if (this.child === child && child.connected) child.send({ type: "soul_context_response", requestId: msg.requestId, context });
        };
        void buildMinecraftSoulContext(appPath, userData, {
          query: msg.request,
          gameConversation: msg.gameConversation ?? [],
          gameSummary: msg.gameSummary,
        }).then((context) => respondContext(context))
          .catch(() => respondContext(null));
      }
    });
    child.once("exit", (code) => {
      if (this.child === child) this.child = null;
      this.viewerUrl = "";
      this.visionCapture.close();
      progress({ type: "progress", description: code === 0 ? "Minecraft 玩家已离线" : `Minecraft sidecar 已退出（${code ?? "unknown"}）` });
      onExit();
    });
    child.send({
      type: "start",
      settings: {
        ...settings,
        soul: this.soulSettings,
        profilesFolder: path.join(userData, "game-bot", "minecraft-auth"),
        stateFile: path.join(userData, "game-bot", "minecraft-state.json"),
      },
    });
  }

  async handleSummaryAction(id: string, action: "generate" | "save" | "discard"): Promise<{ ok: boolean; error?: string }> {
    const draft = this.pendingSummary;
    if (!draft || draft.id !== id) return { ok: false, error: "这份联机记录草稿已过期" };
    if (action === "discard") {
      this.pendingSummary = null;
      this.progress?.({ type: "progress", description: "本次 Minecraft 联机记录未保存" });
      return { ok: true };
    }
    if (action === "generate") {
      try {
        let summary = draft.fallbackSummary;
        if (this.soulSettings?.enabled) {
          const soul = require(path.join(this.sidecarDir, "soul-orchestrator.cjs")) as {
            composeSessionSummary: (config: unknown, input: unknown) => Promise<string>;
          };
          summary = await soul.composeSessionSummary(this.soulSettings, {
            durationMinutes: draft.durationMinutes,
            players: draft.players,
            highlights: draft.highlights,
            earlierConversationSummary: draft.conversationSummary,
            recentConversation: draft.recentConversation,
          });
        }
        draft.generatedSummary = summary;
        this.progress?.({ type: "summary-review", stage: "draft", id: draft.id, summary });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!draft.generatedSummary) return { ok: false, error: "请先生成并查看记录草稿" };
    const saved = saveMinecraftSessionEvent(this.sessionFile, {
      startedAt: draft.startedAt,
      endedAt: draft.endedAt,
      serverLabel: draft.serverLabel,
      players: draft.players,
      summary: draft.generatedSummary,
    });
    this.pendingSummary = null;
    try { this.sessionSaved?.(saved); } catch { /* 气泡插入失败不影响档案保存 */ }
    this.progress?.({ type: "progress", description: "Minecraft 联机记录已按你的确认保存" });
    return { ok: true };
  }

  updateAutonomy(autonomy: MinecraftBotSettings["autonomy"]): boolean {
    const child = this.child;
    if (!child || !child.connected) return false;
    child.send({ type: "autonomy_update", autonomy: { mode: autonomy.mode } });
    return true;
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    if (child.connected) child.send({ type: "stop" });
    const timer = setTimeout(() => { if (this.child === child) child.kill(); }, 5000);
    timer.unref();
  }
}
