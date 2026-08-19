# 音乐播放器 UI 接入进度

> 本文档记录音乐播放器 UI 从 player-demo 原型接入到主项目的进度。
> 上一个 commit `35f08b4` 完成了 M3-M5 后端重构（OpenAPI + mpv + token 持久化），
> 本次工作是 M6：把 player-demo 的 React UI 接到真实后端，作为独立播放器窗口运行。

---

## 架构决策

**接入方式：独立播放器窗口**

- 新增 `renderer/music/` React 入口（960×640 卡片式播放器）
- 通过托盘菜单「打开音乐播放器」打开
- `settings/music` 面板保留 OpenAPI 配置 + 扫码登录（配置类），播放器窗口专注播放
- 职责分离：配置在 settings，播放在独立窗口

**数据流**

```
mpv 后端（MpvController）
  ↓ MUSIC_PLAYBACK_STATE 事件
music-service（onPlaybackStateChange 广播）
  ↓ IPC 广播到所有窗口
renderer/music/App.tsx（订阅 + normalize）
  ↓ props 单向数据流
MusicPlayer 组件（纯展示，零播放逻辑）
```

---

## 已完成

### 1. 主进程窗口骨架

- [x] [ipc-channels.ts](file:///e:/Cyrene-Agent/src/shared/ipc-channels.ts)：新增 `MUSIC_GET_MY_PLAYLISTS` / `MUSIC_GET_PLAYLIST_DETAIL` / `MUSIC_OPEN_PLAYER` / `MUSIC_PLAYER_CLOSE` / `MUSIC_PLAYER_MINIMIZE` 通道
- [x] [window-state.ts](file:///e:/Cyrene-Agent/src/main/windows/window-state.ts)：新增 `musicPlayerWindow` 引用 + setter
- [x] [create-music-player-window.ts](file:///e:/Cyrene-Agent/src/main/windows/create-music-player-window.ts)：新建播放器窗口工厂（960×660，无框透明，dev 加载 `localhost:5173/music/`，prod 加载 `dist/renderer/music/index.html`）
- [x] [window-manager.ts](file:///e:/Cyrene-Agent/src/main/windows/window-manager.ts)：接口暴露 `createMusicPlayerWindow()`
- [x] [window-system-ipc.ts](file:///e:/Cyrene-Agent/src/main/windows/window-system-ipc.ts)：注册播放器窗口控制 IPC（minimize/close/open）

### 2. 后端 IPC handler

- [x] [ipc-handlers.ts](file:///e:/Cyrene-Agent/src/main/music/ipc-handlers.ts)：注册 `MUSIC_GET_MY_PLAYLISTS` / `MUSIC_GET_PLAYLIST_DETAIL`，复用 `service.getMyPlaylists()` / `service.getPlaylistDetail()`
- [x] 修复 `MUSIC_TOGGLE_FAVORITE` 参数不一致 bug（之前只传 encryptedId，现在传 `{ encryptedId, favorite }`）

### 3. 托盘菜单入口

- [x] [tray.ts](file:///e:/Cyrene-Agent/src/main/tray.ts)：新增「打开音乐播放器」菜单项
- [x] [index.ts](file:///e:/Cyrene-Agent/src/main/index.ts)：传入 `createMusicPlayerWindow` 依赖
- [x] [tray.test.ts](file:///e:/Cyrene-Agent/src/main/tray.test.ts)：更新 mock，测试通过

### 4. Vite 构建入口

- [x] [vite.config.ts](file:///e:/Cyrene-Agent/vite.config.ts)：新增 `music` 入口指向 `src/renderer/music/index.html`

### 5. 渲染层 React 入口

- [x] [src/renderer/music/index.html](file:///e:/Cyrene-Agent/src/renderer/music/index.html)：HTML 容器
- [x] [src/renderer/music/main.tsx](file:///e:/Cyrene-Agent/src/renderer/music/main.tsx)：React 挂载点
- [x] [src/renderer/music/player.css](file:///e:/Cyrene-Agent/src/renderer/music/player.css)：从 player-demo 迁移的样式
- [x] [src/renderer/music/assets/logo.png](file:///e:/Cyrene-Agent/src/renderer/music/assets/logo.png)：logo 资源
- [x] [global.d.ts](file:///e:/Cyrene-Agent/src/renderer/global.d.ts)：新增 `*.png` / `*.jpg` / `*.svg` 模块声明（Vite 静态资源 import）

### 6. 组件迁移（player-demo → 主项目）

全部 7 个组件已复制到 `src/renderer/music/components/`，**零改动**（保持 player-demo 的纯展示契约）：

- [x] [MusicPlayer.tsx](file:///e:/Cyrene-Agent/src/renderer/music/components/MusicPlayer.tsx)（仅 logo 引用改为 import）
- [x] [ProgressBar.tsx](file:///e:/Cyrene-Agent/src/renderer/music/components/ProgressBar.tsx)
- [x] [QueueList.tsx](file:///e:/Cyrene-Agent/src/renderer/music/components/QueueList.tsx)
- [x] [SearchResults.tsx](file:///e:/Cyrene-Agent/src/renderer/music/components/SearchResults.tsx)
- [x] [Slider.tsx](file:///e:/Cyrene-Agent/src/renderer/music/components/Slider.tsx)
- [x] [VolumeControl.tsx](file:///e:/Cyrene-Agent/src/renderer/music/components/VolumeControl.tsx)
- [x] [LyricsView.tsx](file:///e:/Cyrene-Agent/src/renderer/music/components/LyricsView.tsx)
- [x] [types.ts](file:///e:/Cyrene-Agent/src/renderer/music/types.ts)（Track/Playlist/PlaybackState/PlaybackActions 契约）

### 7. App.tsx 真实 IPC 桥（替换 mock）

- [x] [src/renderer/music/App.tsx](file:///e:/Cyrene-Agent/src/renderer/music/App.tsx)：实现真实 IPC 桥
  - 订阅 `onPlaybackState`（mpv 状态推送）→ 更新 PlaybackState
  - 订阅 `onStateChanged`（登录态变化）→ 检测登录后自动拉取歌单
  - `loadPlaylists`：调 `getMyPlaylists` + normalize 后端 `MusicPlaylist` → UI `Playlist`
  - `loadPlaylistTracks`：调 `getPlaylistDetail` + normalize `MusicTrack` → UI `Track`，设为 queue
  - `playTrack`：本地 queue 管理（追加/跳播）+ IPC `playTrack(encryptedId)` + 3s loading 超时兜底 + 异步补歌词
  - `togglePlayPause/seek/setVolume/toggleMute`：映射到 mpv IPC 命令
  - `next/prev`：本地计算下一首索引（支持 repeat all / shuffle）+ 调 `playTrack`
  - `toggleRepeat/toggleShuffle`：本地状态（mpv 不持久化播放模式，由前端管理）
  - `toggleFavorite`：调 IPC + 本地 UI 同步
  - 搜索：250ms 防抖 + `search` IPC + normalize 结果
  - 窗口控制：无框窗口的 minimize/close 按钮（通过 preload 暴露的 IPC）
  - 未登录态：显示「音乐服务未就绪」引导到 settings 扫码

### 8. Preload API 扩展

- [x] [preload/music.ts](file:///e:/Cyrene-Agent/src/preload/music.ts)：新增 `getMyPlaylists` / `getPlaylistDetail` / `minimizeWindow` / `closeWindow`，修复 `toggleFavorite` 签名

### 9. 验证

- [x] `tsc --noEmit -p tsconfig.main.json` 干净
- [x] `tsc --noEmit -p tsconfig.preload.json` 干净
- [x] `tray.test.ts` 测试通过

---

## 未完成

### 高优先级（阻塞端到端运行）

- [ ] **renderer tsc 检查未跑**：`tsconfig.renderer.json`（或等价配置）尚未验证 `src/renderer/music/App.tsx` 的类型，可能有 `unknown` cast 之外的类型错误
- [ ] **vitest 全量未跑**：只跑了 tray.test.ts，未跑 music 相关的其他测试（music-service.test.ts / ipc-handlers.test.ts 可能受 `toggleFavorite` 签名变更影响）
- [ ] **dev 启动端到端验证**：尚未启动 `npm run dev` 实际打开播放器窗口，验证：
  - 窗口能正常创建并加载 `localhost:5173/music/`
  - 登录后能拉取歌单显示 chips
  - 点歌能触发 mpv 播放
  - 播放控制（暂停/进度/音量）能正常工作
  - 搜索能返回结果
  - 歌词能异步加载

### 中优先级（体验完善）

- [ ] **settings/music 面板加「打开播放器」按钮**：目前只能从托盘菜单打开，settings 里没有入口
- [ ] **播放模式持久化**：当前 repeatMode/isShuffled 只在前端 state，重启窗口后丢失（可考虑存 localStorage）
- [ ] **queue 持久化**：当前 queue 每次打开窗口都重新拉第一个歌单，未记住上次播放位置
- [ ] **封面防盗链**：网易云封面可能有 Referer 限制，Electron 里可能需要在 main 进程代理或带 Referer（player-demo HANDOFF.md 提到）
- [ ] **mpv 播放模式联动**：当前 next/prev 由前端计算索引后调 `playTrack`，未用 mpv 原生 `playlist-next`（MpvController 已有 `next()`/`prev()` 方法但未用 mpv 内部 playlist）

### 低优先级（打磨）

- [ ] **player.css 适配主项目主题**：player-demo 用 `--accent: #f06292` 粉色主题，主项目有 UI 主题系统（`src/renderer/ui/theme`），可能需要对齐
- [ ] **窗口尺寸自适应**：当前固定 960×660，未做小屏适配
- [ ] **mini/bar variant**：types.ts 预留了 `variant?: "full" | "mini" | "bar"`，demo 只实现了 full
- [ ] **electron-builder 配置**：未确认打包时 `dist/renderer/music/index.html` 是否被正确包含
- [ ] **player-demo 目录清理**：接入完成后 `player-demo/` 可删除或保留为参考

---

## 当前可停止点

**代码层面已完整接入，差一次端到端启动验证。**

下一步若继续，应该：
1. 跑 `npx tsc --noEmit` 全量检查 renderer 类型
2. 跑 `npx vitest run` 全量测试，修 `toggleFavorite` 签名变更引起的测试断言
3. 启动 `npm run dev`，从托盘打开播放器窗口，验证完整播放流程
4. 修发现的问题
5. settings/music 加「打开播放器」按钮
6. commit

---

## 文件清单（本次新增/修改）

**新增**：
- `src/main/windows/create-music-player-window.ts`
- `src/renderer/music/index.html`
- `src/renderer/music/main.tsx`
- `src/renderer/music/App.tsx`
- `src/renderer/music/types.ts`
- `src/renderer/music/player.css`
- `src/renderer/music/assets/logo.png`
- `src/renderer/music/components/{MusicPlayer,ProgressBar,QueueList,SearchResults,Slider,VolumeControl,LyricsView}.tsx`

**修改**：
- `src/shared/ipc-channels.ts`（+5 通道）
- `src/main/windows/window-state.ts`（+musicPlayerWindow）
- `src/main/windows/window-manager.ts`（接口+实现）
- `src/main/windows/window-system-ipc.ts`（+3 IPC handler）
- `src/main/music/ipc-handlers.ts`（+2 IPC handler，修 toggleFavorite 签名）
- `src/main/tray.ts`（+菜单项）
- `src/main/index.ts`（传依赖）
- `src/main/tray.test.ts`（更新 mock）
- `src/preload/music.ts`（+4 API，修 toggleFavorite 签名）
- `src/renderer/global.d.ts`（+png/jpg/svg 模块声明）
- `vite.config.ts`（+music 入口）
