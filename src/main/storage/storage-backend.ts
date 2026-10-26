import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type * as Legacy from "../chats/chats-store-json";
import type { PluginStorage } from "../../plugins/types";
import type { PluginManager } from "../../plugins/manager";
import { setServiceStateProvider } from './service-state';

type Queue = { bootstrap(): Promise<void>; whenIdle(): Promise<void>; view(): unknown };
interface Runtime {
  start(): unknown;
  store: typeof Legacy & { appendProactiveMessage(id: string, input: unknown): unknown };
  pluginStorage(id: string): PluginStorage;
  controllers: Map<string, Queue>;
  call(method: string, ...args: unknown[]): any;
  callAsync(method: string, ...args: unknown[]): Promise<any>;
  stop(): Promise<void>;
}
let runtime: Runtime | undefined, pump: any;
let ready: unknown;
let supportDirectory: string;
setServiceStateProvider((root, namespace) => {
  if(path.resolve(root)!==path.resolve(app.getPath('userData')))return undefined;
  const owner=getStorageRuntime();if(!owner)return undefined;
  if(!owner.call('services.initialized',namespace))throw Error('SQLITE_STARTUP_IMPORT_INCOMPLETE:'+namespace);
  return {get:key=>owner.call('services.get',namespace,key),set:(key,value)=>owner.call('services.set',namespace,key,value),all:()=>owner.call('services.all',namespace),call:(method,...args)=>owner.call(method,...args)};
});
/** Desktop startup selects SQLite before services run; missing/invalid selection fails closed after ready. */
export function getStorageRuntime(): Runtime | undefined {
  if (runtime) return runtime;
  let options: unknown;
  if (process.env.CYRENE_SQLITE_ISOLATION === "1") {
    const stage = path.resolve(app.getAppPath(), ".."), data = path.resolve(process.env.JOINT_DATA ?? "");
    supportDirectory = app.getAppPath();
    require(path.join(supportDirectory, "isolation-boundary.cjs"))(stage, data, app.getPath("userData"));
    options = { runtime: path.join(stage, "runtime"), data, snapshot: path.join(stage, "snapshot"), report: process.env.JOINT_OWNER };
  } else {
    const control = path.join(app.getPath("userData"), ".sqlite-storage");
    if (!fs.existsSync(control)) {
      if(app.isReady?.())throw Error('SQLITE_NOT_INITIALIZED');
      return undefined;
    }
    supportDirectory = app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked/dist/sqlite-runtime") : path.resolve(__dirname, "../../../sqlite-runtime");
    options = require(path.join(supportDirectory, "formal-storage.cjs")).options(app.getPath("userData"), supportDirectory);
    if(!options){if(app.isReady?.())throw Error('SQLITE_NOT_INITIALIZED');return undefined;}
  }
  const candidate: Runtime = require(path.join(supportDirectory, "bridge.cjs"))(options);
  try {
    ready = candidate.start();
    require(path.join(supportDirectory,'startup-service-import.cjs')).importServices(app.getPath('userData'),candidate.call);
    runtime = candidate;
  }
  catch (error) { void candidate.stop().catch(() => {}); throw error; }
  return runtime;
}
export function requireStorageRuntime(profile?: string): Runtime {
  if(profile&&path.resolve(profile)!==path.resolve(app.getPath('userData')))throw Error('SQLITE_PROFILE_MISMATCH');
  const owner=getStorageRuntime();
  if(!owner)throw Error('SQLITE_NOT_INITIALIZED');
  return owner;
}
export function getStorageReady() { return ready; }
export function pluginStorageBackend(rootDir: string): PluginStorage | undefined {
  const id = path.basename(rootDir), owner = getStorageRuntime();
  if (!owner || !["companion-chat", "companion-memory"].includes(id)) return undefined;
  if (path.resolve(rootDir) !== path.join(app.getPath("userData"), "plugin-data", id)) throw new Error("PLUGIN_STORAGE_ROOT_MISMATCH");
  return owner.pluginStorage(id);
}
export async function startStorageSubscribers(manager: PluginManager) {
  const owner = getStorageRuntime(); if (!owner) return;
  if (pump) throw new Error("SQLITE_SUBSCRIBERS_ALREADY_STARTED");
  await owner.controllers.get("companion-memory")?.bootstrap();
  pump = require(path.join(supportDirectory, "event-pump.cjs"))({
    call: owner.callAsync,
    publish: (event: any) => manager.deliverStoredHostEvent(event.type, event),
    settle: async () => { await manager.drainHostEvents(); await owner.controllers.get("companion-memory")?.whenIdle(); },
    pollMs: 250,
  });
  void pump.start();
}
export function getStoragePump() { return pump; }
export async function stopStorageSubscribers() { await pump?.stop(); }
export async function stopStorageRuntime() { await runtime?.stop(); }

/** Host-only run boundary, before prompt providers read their source receipt. */
export async function prepareNativeStorageTurn(input: {
  conversationId: string; runId: string; mode: string; chatBackend?: string;
  inputMessageId?: string; assistantMessageId?: string;
}) {
  const owner = getStorageRuntime();
  if (!owner || input.mode !== "chat" || input.chatBackend !== "companion") return;
  const user = owner.store.getSession(input.conversationId)?.messages.find(m => m.id === input.inputMessageId && m.role === "user");
  if (!user || !input.assistantMessageId) throw new Error("SQLITE_NATIVE_TURN_BOUNDARY_REQUIRED");
  await owner.callAsync("life.beginTurn", input.conversationId, input.runId, user, input.assistantMessageId);
}
export async function failNativeStorageTurn(conversationId: string, runId: string) {
  const owner = getStorageRuntime(); if (!owner) return;
  await owner.callAsync("life.finishNativeTurn", { conversationId, runId, status: "runtime_error", source: "desktop", mode: "chat" });
}
/** Returns true only when the SQLite outbox owns this host notification. */
export async function persistStorageHostEvent(event: string, payload: any): Promise<boolean> {
  const owner = getStorageRuntime(); if (!owner) return false;
  if (event === "conversation:changed" || event === "assistant-message:feedback") {
    // Native mutations already committed these events with the message change.
    const session = owner.store.getSession(payload.conversationId);
    return session?.mode === "chat" || (!session && event === "conversation:changed" && payload.allMessages === true);
  }
  if (!["turn:started", "turn:finished", "prompt:accepted"].includes(event) || !payload?.runId) return false;
  if (!payload.conversationId && event === "prompt:accepted") {
    payload = { ...payload, conversationId: await owner.callAsync("life.runConversation", payload.runId) };
  }
  if (!payload.conversationId) return false;
  const source = await owner.callAsync("life.promptSource", payload.conversationId, payload.runId);
  if (!source) return false; // Other modes and retained channel backends are unchanged.
  if (event === "turn:finished") {
    await owner.callAsync("life.finishNativeTurn", payload); return true;
  }
  if (event === "prompt:accepted" && !["plugin:companion-chat:worldbook", "plugin:companion-memory:memory-context"].includes(payload.providerId)) return false;
  await owner.callAsync("life.queueSubscriberSignal", payload.conversationId,
    event === "turn:started" ? `start:${payload.runId}` : `accept:${payload.runId}:${payload.providerId}`,
    { type: `host:${event}`, runId: payload.runId, ...(event === "prompt:accepted" ? { providerId: payload.providerId, complete: payload.complete } : {}) });
  return true;
}
