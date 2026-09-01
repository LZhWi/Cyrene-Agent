// QQ 音乐设置卡片：检测本地安装 + 后台传输控制。
//
// 和网易云那张卡的区别要在 UI 上说清楚，否则用户会预期错：
//   网易云 = Cyrene 自己放歌（登录、搜索、歌单、本地缓存）
//   QQ 音乐 = 遥控你已经开着的客户端（只有上一首/下一首/播放暂停）
// 之所以只能这样，是因为 QQ 音乐没有面向第三方的官方接口，这里走的是
// Windows 官方的 SMTC，换来零逆向、零签名、不弹窗。
import type { MusicApi, QQCommand, QQMusicDetection } from "./types";
import { deriveQQViewState } from "../../../shared/qq-view-state";
import { getMusicApi } from "./panel";

const statusLine = () => document.getElementById("qq-status-line");
const nowPlayingEl = () => document.getElementById("qq-now-playing");
const controlsEl = () => document.getElementById("qq-controls");
const tagEl = () => document.getElementById("qq-tag");

/** 文案派生在 shared/qq-view-state.ts（纯函数，便于单测）。 */
export const describeDetection = deriveQQViewState;

function render(d: QQMusicDetection): void {
  const { text, tag } = describeDetection(d);
  const line = statusLine();
  if (line) line.textContent = text;

  const np = nowPlayingEl();
  if (np) {
    if (d.nowPlaying) {
      const { title, artist, status } = d.nowPlaying;
      const state = status === "Playing" ? "正在播放" : status === "Paused" ? "已暂停" : status;
      np.textContent = `${state}：${title}${artist ? ` — ${artist}` : ""}`;
      np.classList.remove("is-hidden");
    } else {
      np.textContent = "";
      np.classList.add("is-hidden");
    }
  }

  // 控制按钮只在真的能控制时出现——摆一排点不动的按钮比不摆更糟。
  controlsEl()?.classList.toggle("is-hidden", !d.controllable);

  const tagNode = tagEl();
  if (tagNode) {
    tagNode.textContent = tag ?? "";
    tagNode.classList.toggle("is-hidden", tag === null);
  }
}

async function refresh(api: MusicApi): Promise<void> {
  const line = statusLine();
  if (line) line.textContent = "正在检测…";
  try {
    const res = await api.qqDetect();
    if (res.ok) {
      render(res.data);
    } else if (line) {
      line.textContent = "检测失败，请重试。";
    }
  } catch {
    if (line) line.textContent = "检测失败，请重试。";
  }
}

/** 绑定卡片。重复调用是安全的（幂等）——设置页可能被重新初始化。 */
export function initQQMusicPanel(): void {
  const card = document.getElementById("music-platform-qq");
  if (!card || card.dataset.qqBound === "1") return;
  card.dataset.qqBound = "1";

  const api = getMusicApi();
  if (!api?.qqDetect) {
    const line = statusLine();
    if (line) line.textContent = "当前环境不支持外部播放器控制。";
    return;
  }

  card.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-qq-cmd], #qq-refresh");
    if (!btn) return;
    // 卡片本身没有跳转行为，但阻止冒泡以防未来加上。
    ev.stopPropagation();

    if (btn.id === "qq-refresh") {
      void refresh(api);
      return;
    }
    const command = btn.dataset.qqCmd as QQCommand | undefined;
    if (!command) return;
    void api.qqControl(command).then(() => {
      // 控制后立刻回读一次，让"正在播放"跟上（切歌需要一点时间生效）。
      setTimeout(() => void refresh(api), 400);
    });
  });

  void refresh(api);
}
