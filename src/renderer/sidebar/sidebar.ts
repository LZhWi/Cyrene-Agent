import "../ui/base.css";
import "./sidebar.css";
import "../ui/theme";

interface ModelConfig {
  mode: "auto" | "manual";
  provider: string;
  displayName?: string;
  shortName: string;
  model: string;
  connected: boolean;
  runtimeSync: "off" | "local" | "llm";
}

interface ModelConfigApi {
  get: () => Promise<ModelConfig>;
  onChanged: (callback: (config: ModelConfig) => void) => () => void;
}

type RuntimeStatus = "陪伴中" | "思考中" | "工作中" | "聆听中" | "提醒中" | "离线";
type RuntimeFeeling = "平静" | "开心" | "温柔" | "激动" | "撒娇" | "担心" | "难过" | "感动" | "害羞";

interface RuntimeState {
  status: RuntimeStatus;
  feeling: RuntimeFeeling;
  expression: number;
}

interface RuntimeStateApi {
  get: () => Promise<RuntimeState>;
  onChanged: (callback: (state: RuntimeState) => void) => () => void;
}

interface SidebarApi {
  minimize: () => void;
  close: () => void;
  toggleAlwaysOnTop: () => Promise<boolean>;
  openTasks: () => void;
  openSettings: (section?: string) => void;
  openCall: () => void;
  openWork: () => void;
}

declare global {
  interface Window {
    sidebar?: SidebarApi;
    modelConfig?: ModelConfigApi;
    runtimeState?: RuntimeStateApi;
    lifeStatus?: { getCurrentActivity: () => Promise<string | null> };
  }
}

// 没有 preload 时给浏览器跑留个 no-op，方便 vite 单独打开 sidebar 调试
if (!window.sidebar) {
  (window as unknown as { sidebar: SidebarApi }).sidebar = {
    minimize: () => {},
    close: () => {},
    toggleAlwaysOnTop: () => Promise.resolve(false),
    openTasks: () => {},
    openSettings: (_section?: string) => {},
    openCall: () => {},
    openWork: () => {},
  };
}

const root = document.querySelector(".sidebar") as HTMLElement | null;
const minBtn = document.getElementById("min-btn") as HTMLButtonElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
const pinBtn = document.getElementById("pin-btn") as HTMLButtonElement;
const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement;
const modelSwitchBtn = document.getElementById("model-switch-btn") as HTMLButtonElement;
const openChatBtn = document.getElementById("open-chat-btn") as HTMLButtonElement;
const openWorkBtn = document.getElementById("open-work-btn") as HTMLButtonElement;
const callBtn = document.getElementById("call-btn") as HTMLButtonElement;
const onlineStatusLabel = document.getElementById("online-status-label") as HTMLElement;
const statusEmojiEl = document.getElementById("status-emoji") as HTMLElement;
const statusLabelEl = document.getElementById("status-label") as HTMLElement;
const feelingEmojiEl = document.getElementById("feeling-emoji") as HTMLElement;
const feelingLabelEl = document.getElementById("feeling-label") as HTMLElement;
const feedingModelEl = document.getElementById("feeding-model") as HTMLElement;
const onlineBadge = onlineStatusLabel.closest(".profile__online") as HTMLElement | null;
let runtimeSyncEnabled = false;
let latestRuntimeState: RuntimeState | null = null;
// [你的生活] 当前活动：空闲态（陪伴中）时替换状态位文本，与注入 LLM 的日程同源。
// null = 接口不可用（preload 缺失/主进程异常），回退显示原「陪伴中」。
let lifeStatusText: string | null = null;
let lifeStatusResting = false;

const STATUS_EMOJI: Record<RuntimeStatus, string> = {
  陪伴中: "🌸",
  思考中: "💭",
  工作中: "⚡",
  聆听中: "🫧",
  提醒中: "🔔",
  离线: "💤",
};

const FEELING_EMOJI: Record<RuntimeFeeling, string> = {
  平静: "🌿",
  开心: "✨",
  温柔: "🌸",
  激动: "🎉",
  撒娇: "🥺",
  担心: "💙",
  难过: "💧",
  感动: "🥹",
  害羞: "🌹",
};

function applyRuntimeDisabled(): void {
  statusEmojiEl.textContent = "⚙️";
  statusLabelEl.textContent = "请到设置里开启";
  feelingEmojiEl.textContent = "⚙️";
  feelingLabelEl.textContent = "请到设置里开启";
}

function applyRuntimeState(state: RuntimeState | null): void {
  latestRuntimeState = state;
  if (!runtimeSyncEnabled) {
    applyRuntimeDisabled();
    return;
  }
  const status = state?.status ?? "陪伴中";
  const feeling = state?.feeling ?? "平静";
  if (status === "陪伴中" && lifeStatusText != null) {
    // 空闲态显示她当前的日程活动；深夜日程空窗显示「休息中」
    statusEmojiEl.textContent = lifeStatusResting ? "🌙" : "🌸";
    statusLabelEl.textContent = lifeStatusText;
  } else {
    statusEmojiEl.textContent = STATUS_EMOJI[status] ?? "💬";
    statusLabelEl.textContent = status;
  }
  feelingEmojiEl.textContent = FEELING_EMOJI[feeling] ?? "🌿";
  feelingLabelEl.textContent = feeling;
}

// 「正在」前缀：以"在"开头的条目（如"在心里给今天的心情打个分"）用"正"避免"正在在"
function formatLifeStatus(activity: string | null): string {
  if (activity == null) return "休息中";
  return activity.startsWith("在") ? `正${activity}` : `正在${activity}`;
}

async function refreshLifeStatus(): Promise<void> {
  try {
    const activity = await window.lifeStatus?.getCurrentActivity();
    if (activity === undefined) {
      lifeStatusText = null; // preload 未暴露，回退「陪伴中」
    } else {
      lifeStatusResting = activity == null;
      lifeStatusText = formatLifeStatus(activity);
    }
  } catch {
    lifeStatusText = null;
  }
  applyRuntimeState(latestRuntimeState);
}

async function initRuntimeState(): Promise<void> {
  try {
    const state = await window.runtimeState?.get();
    applyRuntimeState(state ?? null);
  } catch {
    applyRuntimeState(null);
  }
  window.runtimeState?.onChanged((state) => applyRuntimeState(state));
}

function applyModelConfig(config: ModelConfig | null): void {
  const connected = Boolean(config?.connected);
  const wasRuntimeSyncEnabled = runtimeSyncEnabled;
  runtimeSyncEnabled = config?.runtimeSync === "local" || config?.runtimeSync === "llm";
  onlineStatusLabel.textContent = connected ? "在线" : "离线";
  onlineBadge?.classList.toggle("is-offline", !connected);
  // "正在喂养"显示优先级：用户昵称 > 厂商短名 > model id > 兜底
  feedingModelEl.textContent = config?.displayName || config?.shortName || config?.model || "未选择模型";
  if (!runtimeSyncEnabled) applyRuntimeDisabled();
  else if (!wasRuntimeSyncEnabled) applyRuntimeState(latestRuntimeState);
}

async function initModelConfig(): Promise<void> {
  try {
    const config = await window.modelConfig?.get();
    applyModelConfig(config ?? null);
  } catch {
    applyModelConfig(null);
  }
  window.modelConfig?.onChanged((config) => applyModelConfig(config));
}
// 置顶 toggle：点 📌 切换 alwaysOnTop，按钮高亮态反映当前是否已置顶。
pinBtn.addEventListener("click", async () => {
  const pinned = await window.sidebar?.toggleAlwaysOnTop();
  const isPinned = Boolean(pinned);
  pinBtn.classList.toggle("is-active", isPinned);
  pinBtn.setAttribute("aria-label", isPinned ? "取消置顶" : "置顶");
  pinBtn.setAttribute("title", isPinned ? "取消置顶" : "置顶");
});

minBtn.addEventListener("click", () => {
  window.sidebar?.minimize();
});

closeBtn.addEventListener("click", () => {
  window.sidebar?.close();
});

settingsBtn.addEventListener("click", () => {
  window.sidebar?.openSettings();
});

modelSwitchBtn.addEventListener("click", () => {
  // "切换模型"直奔 API 配置标签，而不是默认的通用标签
  window.sidebar?.openSettings("api");
});

callBtn.addEventListener("click", () => {
  window.sidebar?.openCall();
});

// "打开聊天"：拿到最近一条会话 id，让 main 打开聊天窗口并加载它；
// 没有任何会话时先建一个再打开，保证点按钮总能进到一个具体会话。
openChatBtn.addEventListener("click", async () => {
  const chatStore = (window as unknown as {
    chatStore?: {
      list: () => Promise<Array<{ id: string }>>;
      create: (payload?: { identityId?: string | null }) => Promise<{ id: string } | null>;
      openInChatWindow: (sessionId: string) => Promise<unknown>;
    };
  }).chatStore;
  if (!chatStore) return;
  try {
    const list = await chatStore.list();
    let latestId = list.length > 0 ? list[0].id : "";
    if (!latestId) {
      const created = await chatStore.create({ identityId: null });
      latestId = created?.id ?? "";
    }
    if (latestId) await chatStore.openInChatWindow(latestId);
  } catch (err) {
    console.warn("[sidebar] 打开聊天失败:", err);
  }
});

openWorkBtn.addEventListener("click", () => {
  window.sidebar?.openWork();
});

void initModelConfig();
void initRuntimeState();
void refreshLifeStatus();
setInterval(() => void refreshLifeStatus(), 60_000);
