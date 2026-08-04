// tick 主循环 + 事件打断 + 选文案 + 触发 LIVE2D_SHOW_BUBBLE + 响应窗口 + 反馈闭环
import { BrowserWindow, app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import { SCENE_CONFIGS, DESIRE_RATE, RESPONSE_WINDOW_MS } from "./scenes-config";
import { loadManifest, pickItem, resolveAudioPath, readWavDurationMs, readWavBase64 } from "./opener-pack-store";
import { getWeather } from "./weather-cache";
import { snapshot } from "./user-state-sensor";
import { loadState, saveState, accumulateDesire, probabilityGate, applyClickFeedback, applyIgnoreFeedback } from "./desire-engine";
import { NORMAL_QUIET_MS } from "../proactive/proactive-policy";
import { scoreScene } from "./scene-scorer";
import type { OpenerState, SceneId, ShowBubblePayload, WeatherSnapshot } from "./opener-types";
import type { ProactiveCandidate } from "../proactive/proactive-types";
import { loadLocation } from "../location-store";

const TICK_MS = 60_000;
const MAX_DESIRE_ELAPSED_MINUTES = 5;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let responseTimer: ReturnType<typeof setTimeout> | null = null;
let live2dWindow: BrowserWindow | null = null;
let manifest = loadManifest();
let weatherCachedHour = -1;
let lastDesireTickAt: number | null = null;
// 缓存用户城市坐标，避免每 tick 都 geocoding
let cachedCityCoords: { city: string; lat: number; lon: number } | null = null;
let proactiveCandidateHandler: ((candidate: ProactiveCandidate) => Promise<void>) | null = null;

/** 自动定位优先；不可用时回退默认地点。没有可靠地点时不生成天气场景。 */
async function resolveWeatherCoords(): Promise<{ lat: number; lon: number } | null> {
  let cityName = "";
  let mode: "auto" | "fixed" | "off" = "fixed";
  try {
    const profilePath = path.join(app.getPath("userData"), "user-profile.json");
    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, "utf8")) as {
        defaultCity?: string;
        weatherLocationMode?: "auto" | "fixed" | "off";
      };
      cityName = (profile.defaultCity ?? "").trim();
      mode = profile.weatherLocationMode ?? "fixed";
    }
  } catch { /* 配置读取失败时不猜测位置。 */ }
  if (mode === "off") return null;
  if (mode === "auto") {
    const location = loadLocation();
    if (location) return { lat: location.latitude, lon: location.longitude };
  }
  if (!cityName) return null;
  if (cachedCityCoords?.city === cityName) return cachedCityCoords;
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=zh&format=json`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      if (resp.ok) {
        const data = await resp.json() as { results?: Array<{ latitude: number; longitude: number }> };
        if (data.results && data.results.length > 0) {
          cachedCityCoords = { city: cityName, lat: data.results[0].latitude, lon: data.results[0].longitude };
          return cachedCityCoords;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch { /* 解析失败时不猜测位置。 */ }
  return null;
}

function resolveOpenerLocalTime(now: number): { hour: number; minute: number } {
  try {
    const profilePath = path.join(app.getPath("userData"), "user-profile.json");
    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, "utf8")) as { timezone?: string; timezoneMode?: "system" | "manual" };
      const timezone = profile.timezoneMode === "manual" ? profile.timezone?.trim() : "";
      if (timezone) {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).formatToParts(new Date(now));
        return {
          hour: Number(parts.find((part) => part.type === "hour")?.value ?? 0),
          minute: Number(parts.find((part) => part.type === "minute")?.value ?? 0),
        };
      }
    }
  } catch { /* Invalid or unreadable timezone falls back to system local time. */ }
  const local = new Date(now);
  return { hour: local.getHours(), minute: local.getMinutes() };
}

export function setProactiveCandidateHandler(
  handler: ((candidate: ProactiveCandidate) => Promise<void>) | null,
): void {
  proactiveCandidateHandler = handler;
}

export function setLive2dWindow(win: BrowserWindow | null): void {
  live2dWindow = win;
}

export function reloadManifest(): void {
  manifest = loadManifest();
}

export function startOpener(mode: "quiet" | "normal" | "lively"): void {
  stopOpener();
  const rate = DESIRE_RATE[mode];
  // App restart / mode switch establishes a fresh baseline: offline time is not desire time.
  lastDesireTickAt = Date.now();
  tickTimer = setInterval(() => void tick(rate), TICK_MS);
  console.log(`[Opener] 启动，mode=${mode} rate=${rate}/min`);
}

export function stopOpener(): void {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (responseTimer) { clearTimeout(responseTimer); responseTimer = null; }
  lastDesireTickAt = null;
  console.log("[Opener] 停止");
}

async function tick(rate: number): Promise<void> {
  let state = loadState();
  const now = Date.now();
  const snap = snapshot(now);
  Object.assign(snap, resolveOpenerLocalTime(now));
  const elapsedMinutes = lastDesireTickAt === null
    ? 0
    : Math.min(MAX_DESIRE_ELAPSED_MINUTES, Math.max(0, (now - lastDesireTickAt) / TICK_MS));
  lastDesireTickAt = now;

  // 1. 事件打断直通车：离开后恢复
  if (snap.mouseResumeEvent) {
    state.globalDesire = 100;
    saveState(state);
    await dispatchCandidateOrPreset("back_from_away", 100, snap, state, now);
    return;
  }

  // 2. Desire 累积（正常对话静默期内不累积，避免静默期一结束 desire 已过高立刻触发）
  const inQuietPeriod = state.lastNormalConversationEndedAt !== null
    && (now - state.lastNormalConversationEndedAt < NORMAL_QUIET_MS);
  if (!inQuietPeriod) {
    state = accumulateDesire(state, rate, elapsedMinutes);
  }

  // 3. 概率门
  if (!probabilityGate(state)) {
    saveState(state);
    return;
  }

  // 4. 瞬间快照打分
  const weather = await getWeatherIfNeeded(snap.hour);
  const candidates: Array<{ scene: SceneId; score: number }> = [];
  for (const cfg of SCENE_CONFIGS) {
    const score = scoreScene(cfg.id, snap, weather, state, now);
    if (score > 0) candidates.push({ scene: cfg.id, score });
  }

  // 5. 决策
  if (candidates.length === 0) {
    state.globalDesire = Math.max(0, state.globalDesire - 10);
    saveState(state);
    return;
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0].score;
  const ties = candidates.filter(c => c.score >= top * 0.95);
  const winner = ties[Math.floor(Math.random() * ties.length)];

  saveState(state);
  await dispatchCandidateOrPreset(winner.scene, winner.score, snap, state, now);
}

async function dispatchCandidateOrPreset(
  scene: SceneId,
  score: number,
  snap: { hour: number },
  state: OpenerState,
  now: number,
): Promise<void> {
  if (proactiveCandidateHandler) {
    const cfg = SCENE_CONFIGS.find((item) => item.id === scene);
    if (!cfg) return;
    await proactiveCandidateHandler({ sceneId: scene, score, sceneCooldownMs: cfg.cooldownMs });
    return;
  }
  await tryFire(scene, snap, state, now);
}

export async function getPresetFallback(
  scene: string,
  hour: number,
): Promise<{ text: string; payload: ShowBubblePayload } | null> {
  if (!manifest) return null;
  const pack = manifest.packs[scene];
  if (!pack) return null;
  const state = loadState();
  const item = pickItem(pack.items, hour, state.recentItems[scene] ?? []);
  if (!item) return null;
  const wavPath = resolveAudioPath(item.audio);
  if (!wavPath) return null;
  return {
    text: item.text,
    payload: {
      text: item.text,
      audioBase64: readWavBase64(wavPath),
      format: "wav",
      durationMs: readWavDurationMs(wavPath),
      sceneId: scene,
      itemId: item.id,
    },
  };
}

async function getWeatherIfNeeded(hour: number): Promise<WeatherSnapshot> {
  const empty: WeatherSnapshot = { isRaining:false, precip:0, temp:0, tempDropFromYesterday:0, isSunny:false, tempComfortable:false };
  if (hour < 6 || hour > 22) return empty;
  if (hour === weatherCachedHour) {
    const coords = await resolveWeatherCoords();
    if (!coords) return empty;
    return getWeather(coords.lat, coords.lon);
  }
  weatherCachedHour = hour;
  const coords = await resolveWeatherCoords();
  if (!coords) return empty;
  return getWeather(coords.lat, coords.lon);
}

async function tryFire(scene: SceneId, snap: { hour: number }, state: OpenerState, now: number): Promise<void> {
  if (!manifest) return;
  const pack = manifest.packs[scene];
  if (!pack) return;

  const recent = state.recentItems[scene] ?? [];
  const item = pickItem(pack.items, snap.hour, recent);
  if (!item) {
    console.warn(`[Opener] 场景 ${scene} 无可用文案`);
    return;
  }

  const wavPath = resolveAudioPath(item.audio);
  if (!wavPath) {
    console.warn(`[Opener] 音频不存在: ${item.audio}`);
    return;
  }

  const durationMs = readWavDurationMs(wavPath);
  const audioBase64 = readWavBase64(wavPath);

  const cfg = SCENE_CONFIGS.find(c => c.id === scene)!;
  if (cfg.todayFiredFlag) state.todayFired[cfg.todayFiredFlag] = true;
  state.lastFiredAt[scene] = now;
  const newRecent = [item.id, ...recent].slice(0, Math.max(cfg.recentAvoidN, 1) + 2);
  state.recentItems[scene] = newRecent;
  state.lastTriggeredScene = scene;
  state.lastTriggeredAt = now;
  state.globalDesire = 0;
  saveState(state);

  const payload: ShowBubblePayload = {
    text: item.text,
    audioBase64,
    format: "wav",
    durationMs,
    sceneId: scene,
    itemId: item.id,
  };
  if (live2dWindow && !live2dWindow.isDestroyed()) {
    live2dWindow.webContents.send(IPC.LIVE2D_SHOW_BUBBLE, payload);
  }

  startResponseWindow(scene, now);
}

function startResponseWindow(scene: SceneId, firedAt: number): void {
  if (responseTimer) clearTimeout(responseTimer);
  responseTimer = setTimeout(() => {
    let state = loadState();
    if (state.lastTriggeredScene === scene && state.lastTriggeredAt === firedAt) {
      state = applyIgnoreFeedback(state, scene);
      saveState(state);
      console.log(`[Opener] ${scene} 被忽略`);
    }
    responseTimer = null;
  }, RESPONSE_WINDOW_MS);
}

export function handleBubbleClick(sceneId: string, itemId: string): void {
  let state = loadState();
  if (state.lastTriggeredScene !== sceneId) return;
  let state2 = applyClickFeedback(state, sceneId);
  if (responseTimer) { clearTimeout(responseTimer); responseTimer = null; }
  saveState(state2);
  console.log(`[Opener] ${sceneId} 被接话（点气泡）`);
}

export function handleChatWindowOpened(): void {
  if (!responseTimer) return;
  let state = loadState();
  const scene = state.lastTriggeredScene;
  if (!scene) return;
  let state2 = applyClickFeedback(state, scene);
  clearTimeout(responseTimer);
  responseTimer = null;
  saveState(state2);
  console.log(`[Opener] ${scene} 被接话（打开 chat）`);
}

/** 手动测试：直接读第一条可用 wav 发气泡，不走 Desire/state 逻辑。 */
export async function testFire(): Promise<void> {
  if (!manifest || !live2dWindow || live2dWindow.isDestroyed()) {
    console.warn("[Opener] testFire: manifest 或桌宠窗口未就绪");
    return;
  }
  for (const [sceneId, pack] of Object.entries(manifest.packs)) {
    for (const item of pack.items) {
      const wav = resolveAudioPath(item.audio);
      if (wav) {
        const payload: ShowBubblePayload = {
          text: item.text,
          audioBase64: readWavBase64(wav),
          format: "wav",
          durationMs: readWavDurationMs(wav),
          sceneId,
          itemId: item.id,
        };
        live2dWindow.webContents.send(IPC.LIVE2D_SHOW_BUBBLE, payload);
        console.log(`[Opener] testFire: ${sceneId}/${item.id}`);
        return;
      }
    }
  }
  console.warn("[Opener] testFire: 无可用音频");
}
