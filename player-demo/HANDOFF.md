# 音乐播放器 UI - 后端接入交接文档

> UI 已完成（React 18 + TS，纯展示层，零播放逻辑）。
> 你的任务：用真实 mpv 后端替换 `src/App.tsx` 中的 mock 引擎，**组件层不需要改**。
> 运行 demo：`cd player-demo && npm install && npm run dev`（端口 5173）。

---

## 1. 架构总览

```
┌─────────────────────────────────────────────┐
│ App.tsx  ← 你唯一要重写的文件（mock → mpv IPC）│
│   持有 PlaybackState，暴露 PlaybackActions     │
└──────────────────┬──────────────────────────┘
                   │ props（单向数据流）
┌──────────────────▼──────────────────────────┐
│ MusicPlayer.tsx  ← 不要改                    │
│   ├─ ProgressBar / Slider（进度、可拖拽）     │
│   ├─ VolumeControl（喇叭常亮，悬停渐显）      │
│   ├─ QueueList（播放队列）                   │
│   ├─ SearchResults（搜索结果，点歌即播）      │
│   └─ LyricsView（点唱片渐显歌词）             │
└─────────────────────────────────────────────┘
```

原则：UI 只读 props、只调 actions 回调，不持有任何播放状态。

## 2. 数据契约（`src/types.ts`）

### Track

```typescript
interface Track {
  encryptedId: string;    // 32位hex，API 用，UI 只透传
  originalId: string;     // 数字字符串，作为歌曲唯一 key
  name: string;
  artists: string[];
  album?: string;
  coverImgUrl?: string;   // 直接喂 <img src>，可能缺失（UI 有兜底）
  durationMs?: number;
  visible: boolean;       // false = 不可播放，UI 灰显 + "无法播放" 标签
  isFavorite?: boolean;   // 收藏占位，语义你定
  lyrics?: LyricLine[];   // { timeMs, text }[]，升序；暂无则显示"暂无歌词"
}
```

### Playlist

```typescript
interface Playlist {
  originalId: string;
  name: string;           // 顶部 chip 文案
  coverImgUrl?: string;
  trackCount: number;
  tracks: Track[];
}
```

### PlaybackState（你订阅 mpv 事件后推给 UI）

```typescript
interface PlaybackState {
  currentTrack: Track | null;
  isPlaying: boolean;
  positionMs: number;       // mpv time-pos 事件
  durationMs: number;       // mpv duration 事件
  volume: number;           // 0-100
  isMuted: boolean;
  queue: Track[];
  queueIndex: number;
  repeatMode: "off" | "all" | "one";
  isShuffled: boolean;
  isLoading: boolean;       // mpv 启动/换歌中，UI 显示转圈并禁用播放键
  error?: string;           // 有值时 UI 顶部显示错误条 + 重试按钮
}
```

### PlaybackActions（UI 会调用的命令，你发 IPC 给 main 进程）

```typescript
interface PlaybackActions {
  playTrack(track: Track): void;    // 播放指定歌曲（在队列则跳播，不在则入队尾再播）
  togglePlayPause(): void;
  next(): void;                     // 当前 mode 决定下一首逻辑
  prev(): void;                     // demo 语义：播放>3s 先回开头，否则切上一首
  seek(positionMs: number): void;
  setVolume(volume: number): void;  // 0-100
  toggleMute(): void;
  addToQueue(track: Track): void;
  removeFromQueue(index: number): void;  // 删除当前播放项时 demo 语义：停止播放
  loadPlaylist(playlist: Playlist): void; // 切歌单：换整个 queue
  toggleRepeat(): void;             // off → all → one 轮换
  toggleShuffle(): void;
  toggleFavorite(track: Track): void;     // 占位，收藏语义你接
}
```

### MusicPlayerProps（组件最终签名）

```typescript
interface MusicPlayerProps {
  state: PlaybackState;
  actions: PlaybackActions;
  playlists: Playlist[];                      // 用户歌单，顶部 chips
  activePlaylistId: string;
  onSelectPlaylist(playlist: Playlist): void; // 点 chip → 通常转调 loadPlaylist
  searchResults: Track[];                     // 搜索结果回传
  isSearching: boolean;                       // 搜索中转圈
  onSearch(query: string): void;              // query 变化时调（UI 已做 250ms 防抖）
  className?: string;
  variant?: "full" | "mini" | "bar";          // 预留，demo 只实现了 full
}
```

## 3. UI 已定型的交互（后端需匹配的语义）

| 交互 | 语义 |
|---|---|
| 顶部歌单 chips | 点击切换整个播放队列；`activePlaylistId` 高亮 |
| 侧栏搜索框 | 输入即有 250ms 防抖 → `onSearch`；清空 query 恢复队列视图 |
| 搜索结果点歌 | 调 `playTrack`；demo 行为：不在队列则追加队尾并播放 |
| 模式单键轮换 | 顺序 → 列表循环 → 单曲循环 → 随机 → 顺序（UI 组合 `toggleRepeat`/`toggleShuffle` 实现，你也可自己定） |
| 自动连播 | 播完按 repeatMode/isShuffled 决定下一首；demo 逻辑在 App.tsx 定时器里，可照抄 |
| 键盘快捷键 | 空格=播放暂停，←→=±5s，↑↓=音量±5（输入框聚焦时不触发） |
| `visible: false` | 灰显 + 禁用 + 点播放时报错「暂时无法播放」 |

## 4. 你需要实现的模块

1. **mpv 事件桥**：订阅 mpv 的 `time-pos` / `duration` / `pause` / `volume` / `end-file` 等 property-change，聚合成 `PlaybackState` 推给渲染层
2. **IPC 命令层**：把 8 个 playback 命令映射到 mpv 控制（`loadfile` / `cycle pause` / `seek` / `set volume` ...）
3. **歌单数据源**：`playlists` 从你们的歌单 API/缓存拿；`loadPlaylist` 换 queue
4. **搜索**：`onSearch(query)` → 搜索 API → `searchResults`；注意 UI 期望空 query 时清空结果
5. **歌词**：`Track.lyrics` 从 LRC 解析成 `{ timeMs, text }[]`；可以播放后再异步补上（UI 响应式）
6. **封面**：`coverImgUrl` 网络加载；Electron 里注意防盗链（可能要在 main 进程代理或带 Referer）

## 5. Demo 里可直接照抄的参考实现（`src/App.tsx`）

- `startTrack`：换歌时 450ms 模拟加载（→ 换成 mpv `loadfile` + 等 `duration`）
- 播放进度定时器 + 播完连播逻辑（→ 换成 mpv `time-pos` 事件 + `end-file` 处理）
- `handleSearch` 的防抖与 loading 态
- `removeFromQueue` 删当前项的边界处理

## 6. 不要做的事

- 不要改 `src/components/` 下任何文件；如果 props 不够用，先沟通再加
- 不要在组件里引入 `<audio>` / howler / 任何播放库
- 不要绕过 `PlaybackState` 自己维护镜像状态

## 7. 设计规范（已定稿）

- 主题：白色底 + 粉色强调 `--accent: #f06292`（hover `#f48fb1`，错误 `#d6336c`），全部走 CSS 变量
- 图标：lucide-react，无 emoji
- 布局：960×640 卡片；顶部 logo+歌单 chips；左舞台（唱片⇄歌词渐隐切换）右播放列表（可收起成窄条）；底部控制栏左收藏 / 中播放控制居中 / 右音量
- logo：`public/logo.png`，集成时改走本地资源
