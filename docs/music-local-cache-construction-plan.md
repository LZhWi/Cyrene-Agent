# 音乐本地缓存 + 播放模式改造 施工文档

> 日期：2026-08-19 · 状态：已 review，施工中 · 一次性施工
> review 修正已并入：eof-reached 为播完事实源、inFlight 用 Promise 复用、index 原子写 + 串行、启动对账、PlaybackMode 含 shuffle、all 统一叫"列表循环"、切歌不取消下载

## 背景

- 当前播放链路：点歌 → OpenAPI 拿 playUrl（CDN 直链，约 20 分钟过期）→ mpv 流式播放，播完即丢，本地什么都不留
- 三个现存问题：
  1. 一首歌播完后再点播放键没反应（mpv 进 idle 空载，toggle 对空载无效，且前端把 currentTrack 清了导致按钮 disabled）
  2. 播放模式（顺序/列表循环/单曲循环/随机）只换图标不生效：`computeNextIndex` 不处理单曲循环，且没有任何"播完自动续播"逻辑
  3. 每次重播同一首歌都要重新调 API，烧配额（昨日 5000 配额被闭包陷阱烧穿的事故还在眼前）

## 设计总览

### 核心思路

**方案B：边播边存**。mpv 照常从 CDN 流式播放（体验不变），主进程同时并行下载同一 URL 到本地。播完时文件已存好，单曲循环 / 重播直接走本地文件——零延迟、零流量、零 API 调用。

### 两层播放体系

| | 普通歌单（网易云） | 本地缓存歌单 |
|---|---|---|
| 可选模式 | 只放一次 / 单曲循环 | 顺序 / 随机 / 单曲循环 / 只放一次 |
| 自动连播 | 否（单曲循环除外） | 是 |
| 数据来源 | OpenAPI | 本地文件 |
| 网络依赖 | 有 | 无（断网可播） |

- 普通歌单刻意不自动连播：每首歌都要 API 配额，连播会烧配额
- 缓存歌单是"免费无限播"池子，四模式全开才有意义
- 单曲循环的实现载体就是本地缓存：播完 → 本地文件已就绪 → 秒开重播

### 播完判定：keep-open + eof-reached（一处改动修三个问题）

mpv 启动参数加 `--keep-open=always`：

- 播完 mpv 停在结尾、paused=true，**不进 idle**，loaded 保持 true，track 元数据保留
- **事实源 = mpv 的 `eof-reached` 属性**（官方推荐配合 keep-open 判断 EOF）：MpvController 把它纳入 PlaybackState（`eofReached`）推给前端；`position >= duration - 1s` 仅作 fallback 兜底（防 eof 事件丢失），不作 Ground Truth——避免用户在最后 1 秒手动暂停被误判成自然播完
- 三个问题统一解决：
  1. **播完点播放**：文件还加载着，前端点播放 = `playTrack(currentTrack)`，有缓存秒开（不再有 idle 空载问题）
  2. **单曲循环**：播完判定 + mode=one → 自动 `playTrack(currentTrack)`
  3. **缓存歌单自动连播**：播完判定 + 列表循环/随机 → `computeNextIndex` 自动下一首

### 播放模式命名（review 修正）

- 类型改名 `PlaybackMode`（shuffle 不是 repeat 的一种）：`"off" | "all" | "one" | "shuffle"`
- 语义统一：`off`=只放一次，`all`=**列表循环**（播到末尾回第一首），`one`=单曲循环，`shuffle`=随机
- UI 文案与 `computeNextIndex` 行为都按此语义，"顺序播放到末尾停止"不存在（末尾停止就是 off 在缓存歌单的表现）

## 施工步骤

### 1. 主进程：缓存下载器（新文件 `src/main/music/cache-downloader.ts`）

- 目录：`<runtimeDir>/music-cache/`（与现有 lyrics-cache 同级）
- 文件命名：`<encryptedId>.mp3`；下载中写 `<encryptedId>.mp3.part`，完成后 rename
- 索引：`<runtimeDir>/music-cache/index.json`，数组形式存 `{ encryptedId, name, artists, album, durationMs, coverUrl, size, cachedAt }`
- **索引一致性（review 修正）**：内存 `Map` 是唯一当前状态，所有 mutation 串行执行；持久化走 `index.json.tmp` → `rename` 原子替换，杜绝并发写丢更新、崩溃写半截
- **`isCached(id)` 双条件**：`index.has(id) && exists(filePath)`——用户手动删了文件也不会"假命中"
- `download(track, playUrl)`：fire-and-forget（**切歌不取消**，下完就留）；流式写入 .part，结束后与 Content-Length 比对（CDN 不给 Content-Length 时信任正常 end），一致则 rename + 更新索引 + 通知 service
- **inFlight 用 Promise 复用（review 修正）**：`Map<string, Promise<CacheResult>>` 而非 Set——并发的第二处调用拿到同一个 Promise，而不是被拒绝；service 层"未缓存但下载中"时 await 该 Promise 直接播本地，逻辑上杜绝重复打 API（不靠下载比播放快的 timing 赌）
- **结构化日志**（对齐现有 `[music-debug]` 风格，方便 agent 读终端去重/选播）：
  - 下载开始：`[music-cache] download start: { trackId, name, urlLen }`
  - 缓存完成：`[music-cache] cached: { trackId, name, size, path }`
  - 命中跳过：`[music-cache] skip (already cached): { trackId, name }`
  - agent 拿到 trackId 就能直接调 music_play_track 播本地文件（后端 playTrack 自动命中缓存），无需知道文件路径
- 去重：`isCached(id)`（索引+文件双命中）跳过；`inFlight` 命中则复用现有 Promise
- `listTracks()`：读索引返回 Track 列表；`getFilePath(id)`：返回本地路径
- `remove(id)`：删音频文件 + 从索引移除 + 通知 service（正在播放该曲目时拒删，返回错误码 `E_CACHE_TRACK_PLAYING`）
- **导入用户本地音乐** `importFiles(paths)`：
  - 文件复制进 `music-cache/`，命名 `local-<短hash>.<原扩展名>`
  - 索引项 id 用 `local-<短hash>`（区别于网易云 32-hex id），source 字段标 `"imported"`
  - **导入时即解析元数据**（引 `music-metadata` 依赖）：歌名/歌手/专辑/时长入库，导入不播也能在列表看到完整信息；解析不到的字段回退文件名（歌名）/留空
  - 封面不入库（从简，导入曲目用默认唱片图标）
  - 去重：同名同大小跳过
  - 支持格式：mp3 / flac / wav / ogg / m4a / aac
  - 导入完成同样 `emitCacheUpdated()`
- **启动 reconcile（review 修正）**：不只清 .part——索引与文件双向对账：索引有记录但文件不存在的项移除；文件存在但索引没有的（崩溃前没写完索引）按文件名恢复或清除；保证 `isCached()` 永不假命中

### 2. 主进程：music-service.ts 接入缓存

- `playTrack(encryptedId)` 改造（顺序即优先级）：
  1. `isCached(id)` → 命中 → `mpv.load(file路径)` + `setTrack`（**不调 API，省配额**）；缓存命中判断在 service 层，先于 provider 的 assertEncryptedId，所以 `local-` 开头的导入曲目 ID 也能走通
  2. `isDownloading(id)` → **await 现有下载 Promise**（Promise 复用），完成后播本地——"单曲循环绝不二次调 API"由此成为逻辑保证
  3. 都没有 → 原链路（getSongDetail → dispatch），dispatch 成功后 fire-and-forget `cacheDownloader.download(track, playUrl)`
- dispatcher（music-service.ts 内部）在拿到 playUrl 处顺手触发下载——CDN 直链 20 分钟过期，必须当下存
- 新增 `getCachedTracks()`：返回缓存索引 Track 列表
- 新增 `removeCachedTrack(encryptedId)`：调 downloader.remove + 拒删保护（正在播放时抛 E_CACHE_TRACK_PLAYING）+ emitCacheUpdated
- 下载完成时 `emitCacheUpdated()`：走新的广播通道推给渲染进程

### 3. 主进程：mpv-controller.ts + shared/music-types.ts

- 启动参数加 `--keep-open=always`
- `eof-reached` 已在观察列表中，`applyPropertyChange` 把它写进 `state.eofReached` 并随 PlaybackState 推送（shared 类型加 `eofReached?: boolean`）；`load()` 新曲时重置为 false
- `stop()` 行为不变（stop 后照常进 idle）

### 4. 主进程 + shared + preload：新 IPC

- `ipc-channels.ts` 新增：
  - `MUSIC_GET_CACHED_TRACKS: "music:get-cached-tracks"`（invoke）
  - `MUSIC_REMOVE_CACHED_TRACK: "music:remove-cached-track"`（invoke，参数 encryptedId）
  - `MUSIC_IMPORT_LOCAL_TRACKS: "music:import-local-tracks"`（invoke，弹系统文件选择框，主进程 `dialog.showOpenDialog` 多选，filters 限定音频格式）
  - `MUSIC_CACHE_UPDATED: "music:cache-updated"`（事件广播）
- `ipc-handlers.ts` 注册 handler（照现有模式）
- `preload/music.ts` 暴露 `getCachedTracks()` / `removeCachedTrack(id)` / `importLocalTracks()` / `onCacheUpdated(h)`

### 5. 前端：App.tsx 播完逻辑 + 模式体系

- **播完判定**：`onPlaybackState` 里以 `mpv.eofReached === true` 为事实源（`paused && durationMs > 0 && positionMs >= durationMs - 1000` 仅作 fallback），置一个 `endedRef` 标记（一次性，防重复触发），触发模式路由：
  - 单曲循环 → `playTrack(currentTrack)`（本地秒开）
  - 缓存歌单 + 列表循环/随机 → `playTrack(next)`（本地秒开）
  - 只放一次 → 停（positionMs 保留在结尾，播放键可点 = 重播）
- **点播放重播**：`togglePlayPause` 里若 `endedRef` 为真且非 playing → `playTrack(currentTrack)` 而不是 `playbackToggle`
- **缓存歌单**：虚拟歌单 `{ id: "__local_cache__", name: "本地缓存", ... }` 插在 playlists 头部；tracks 来自 `getCachedTracks()`；订阅 `onCacheUpdated` 刷新（下载完成 + 删除后都会触发）；播放其中歌曲照常走 `api.playTrack`（后端自动命中本地文件）
- **删除缓存歌曲**：`onRemoveCachedTrack(track)` → `api.removeCachedTrack(id)`；删的是当前播放曲 → 后端拒删返回错误码，前端 toast「正在播放，无法删除」；删除成功后本地立即从缓存歌单 tracks 移除（onCacheUpdated 兜底同步）
- **导入本地音乐**：`onImportLocalTracks` → `api.importLocalTracks()`（主进程弹文件框）→ 成功后 onCacheUpdated 自动刷新缓存歌单；导入的曲目同样参与四模式播放
- **模式集合**：`activePlaylistId === "__local_cache__"` 时四模式，否则双模式（off/one）；`cycleMode` 在当前集合内轮换；localStorage 按歌单类型存两份 key（`mode:online` / `mode:cache`）；切歌单时模式随歌单类型切换
- `loaded === false` 清空 currentTrack 的旧分支保留（仅覆盖真正停止/异常场景），播完不再走它（keep-open 下 loaded 保持 true）

### 6. 前端：MusicPlayer.tsx + types.ts

- types：`RepeatMode` 改名 `PlaybackMode = "off" | "all" | "one" | "shuffle"`（off=只放一次，all=列表循环，one=单曲循环，shuffle=随机）；`PlaybackState.repeatMode` 同步改名 `playbackMode`；新增 props `modeSet: "online" | "cache"`、`onRemoveCachedTrack?(track: Track): void` 由 App 传入
- `cycleMode` 按 modeSet 轮换：online → [off, one]，cache → [off, all, one, shuffle]；文案 MODE_META 统一（all 显示"列表循环"）
- **QueueList 删除入口**：仅缓存歌单（`modeSet === "cache"`）下每行 hover 显示删除小按钮（Trash2 图标）；普通歌单不显示（removeFromQueue 语义是移出队列，与删缓存文件是两回事，不混用）
- **导入按钮**：缓存歌单激活时，panel-header 里加"导入"按钮（FolderPlus 图标），点击调 `onImportLocalTracks`；仅缓存歌单显示
- 导入曲目在列表里与缓存曲目同渲染（不做"导入/缓存"分组，也不加来源标记，从简）
- SearchResults / 键盘快捷键不受影响

### 7. 清理与验证

- 移除本阶段遗留的 `[music-debug]` 调试日志（保留 playTrack 失败的 warn）
- `npm run build:main` / `build:renderer` / `build:preload` 全绿
- vitest：music-service 现有 31 个测试通过，新增 cache-downloader 单测（下载完成收录 / 中断不收录 / Promise 复用去重 / 原子写索引 / reconcile 对账）

## 验收标准

1. 播放任意在线歌单歌曲，播完后：单曲循环模式自动重播（终端无新 API 请求——由 Promise 复用逻辑保证，非 timing 赌注；含"下载比播放慢"场景：播完时若仍在下载，重播会等下载完再放本地）；只放一次模式停在结尾、点播放键能重播
2. **下载完成的歌曲进入本地缓存歌单；下载失败或中断的不进入**（中途切歌不取消下载，已完成的照常收录）；终端能看到 `[music-cache] cached: { trackId, name, size }` 日志
3. 缓存歌单内：列表循环/随机/单曲循环/只放一次全部真实生效，自动连播无卡顿
4. 普通歌单只有"只放一次/单曲循环"两个模式可切换
5. 同一首歌第二次播放：终端无 getSongDetail 日志（走本地）
6. 断网后缓存歌单照常播放
7. 缓存歌单每行 hover 出删除按钮：非播放中曲目删除后文件和列表同步消失；正在播放的曲目删除被拒并提示
8. 导入按钮弹系统文件框，多选 mp3/flac 等导入后立即出现在缓存歌单且带歌名/歌手/时长（不播放也能看到完整信息），并能正常播放；重复导入同名同大小文件被跳过
9. 手动删除 music-cache 目录里的 mp3 文件后重启：索引对账自动清掉该记录，播放该曲走在线链路而非"假命中"报错
10. 现有测试零回归

## 边界与后续（本次不做）

- 缓存无容量上限、无清理策略（后续可加 LRU/上限）
- 无损音质、付费曲目下载受限（playUrl 拿不到时照旧报"暂不可播"，不缓存）
- agent 侧音乐工具（music_search/music_play_track）无需改动即自动受益：playTrack 命中缓存走本地，终端 `[music-cache]` 日志供 agent 判断哪些歌零成本可播
