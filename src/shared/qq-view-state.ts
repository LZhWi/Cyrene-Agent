// QQ 音乐卡片的视图状态派生 —— 纯函数，无 DOM 依赖。
// 与 music-view-state.ts 的 deriveNeteaseViewState 同一个套路：
// 把"状态 → 文案"的判断抽出来，好单独测，也好在别处复用。

export interface QQMusicDetectionLike {
  installed: boolean;
  version: string | null;
  running: boolean;
  helperAvailable: boolean;
}

export type QQViewTag = "未安装" | "组件缺失" | "未运行" | "已连接";

export interface QQViewState {
  text: string;
  tag: QQViewTag;
}

/**
 * 三种"用不了"必须分开说，因为用户要做的事完全不同：
 *   未安装   → 去装
 *   组件缺失 → 构建 helper（开发环境常见）
 *   未运行   → 打开播放器
 * 判断顺序即优先级：越根本的原因越先报。
 */
export function deriveQQViewState(d: QQMusicDetectionLike): QQViewState {
  // 卡片正文宽度只有 ~200px，文案必须短，否则会折成三四行把卡片撑高。
  // 状态本身由右上角的 tag 表达，正文只补充 tag 说不完的那部分。
  if (!d.installed) {
    return { text: "未检测到 QQ 音乐", tag: "未安装" };
  }
  const version = d.version ? ` ${d.version}` : "";
  if (!d.helperAvailable) {
    return { text: `已安装${version} · 需运行 npm run build:media-helper`, tag: "组件缺失" };
  }
  if (!d.running) {
    return { text: `已安装${version} · 打开后即可控制`, tag: "未运行" };
  }
  return { text: `已连接${version} · 后台控制，不弹窗`, tag: "已连接" };
}
