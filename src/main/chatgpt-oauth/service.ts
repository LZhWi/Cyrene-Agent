import { app, safeStorage, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { setChatGptEndpoint } from "./runtime";

// Derived from the isolated, verified subscription-oauth integration; no pilot data is imported.
const { createOAuth } = require("./lib/official-oauth.cjs");
const { startProxy } = require("./lib/proxy.cjs");
let auth: ReturnType<typeof createOAuth>;
let bridge: Promise<{ close: () => Promise<void> }> | undefined;
function getAuth() {
  if (auth) return auth;
  app.once("before-quit", () => { cancelChatGptSignIn(); void bridge?.then(p => p.close()).catch(() => {}); });
  const root = path.join(app.getPath("userData"), "chatgpt-oauth");
  const stateFile = path.join(root, "registration.json");
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
  const write = (file: string, value: string | Buffer) => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file + ".tmp", value, { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  };
  const secretFile = (key: string) => {
    if (!/^[\w.-]+$/.test(key)) throw new Error("Invalid credential key");
    return path.join(root, key + ".encrypted");
  };
  auth = createOAuth({
    storage: { get: (key: string) => state[key], set: (key: string, value: unknown) => {
      state[key] = value; write(stateFile, JSON.stringify(state));
    } },
    secrets: {
      get: async (key: string) => fs.existsSync(secretFile(key)) ? safeStorage.decryptString(fs.readFileSync(secretFile(key))) : null,
      set: async (key: string, value: string) => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("系统加密存储不可用，无法保存授权");
        write(secretFile(key), safeStorage.encryptString(value));
      },
    },
  });
  return auth;
}
export async function ensureChatGptBridge(): Promise<void> {
  if (!bridge) {
    bridge = startProxy({ oauth: getAuth(), allowFunctions: true }).then((proxy: { baseUrl: string; secret: string; close: () => Promise<void> }) => {
      setChatGptEndpoint({ baseUrl: proxy.baseUrl, apiKey: proxy.secret });
      return proxy;
    }).catch((error: unknown) => { bridge = undefined; throw error; });
  }
  await bridge;
}
export const chatGptStatus = async (): Promise<{ connected: boolean; planEnabled: boolean; label?: string }> => getAuth().status();
export async function signInChatGpt() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统加密存储不可用");
  const attempt = await getAuth().begin();
  try { await shell.openExternal(attempt.url); return await attempt.completion; }
  catch (error) { attempt.cancel(); throw error; }
}
export function cancelChatGptSignIn(): void { auth?.dispose(); }
export async function listChatGptModels(): Promise<Array<{ id: string; name: string }>> {
  const token = await getAuth().accessToken();
  const response = await fetch("https://api.openai.com/v1/models", {
    redirect: "error", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`ChatGPT 模型列表获取失败（${response.status}），请检查授权`);
  const data = await response.json() as { models?: Array<{ slug: string; display_name?: string; visibility: string }> };
  return (data.models ?? []).filter(m => m.visibility === "list").map(m => ({ id: m.slug, name: m.display_name ?? m.slug }));
}
