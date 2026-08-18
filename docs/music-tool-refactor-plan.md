# Cyrene 音乐工具重构方案

> 基于 docs/music-tool-analysis.md 第五至七章结论 + OpenAPI 官方文档实测调研
> 状态：待审阅，未开始执行

---

## 一、决策与目标

### 1.1 已确认决策

- **主线方案 C**：重写为原生 `ToolDefinition[]`，直连官方 OpenAPI，废弃 Python 后端 + CITA 间接层
- **OpenAPI 资质已拿到**（appId + privateKey）
- **config 入口**：renderer 设置面板加一个入口让用户填 appId/privateKey
- **扫码必须做**：官方 ncm-cli 明确要求 `configure`（填 key）+ `login`（扫码）两步缺一不可，用户级 endpoint（每日推荐/我的歌单/创建歌单/我的收藏）必须有用户 context 才能调通
  - renderer 侧二维码 UI + 轮询逻辑已存在（[panel.ts:170-183](file:///e:/Cyrene-Agent/src/renderer/settings/music/panel.ts#L170-L183)、[panel.ts:120-145](file:///e:/Cyrene-Agent/src/renderer/settings/music/panel.ts#L120-L145)），复用
  - main 侧 `LoginOrchestrator` 重写（weapi QR → OpenAPI QR），`CookieVault` 改造为 `TokenVault`（存 accessToken）
- **播放路径改用 mpv**：放弃 orpheus://（无法控制播放/依赖网易云桌面客户端），改用 mpv 子进程 + React HTML 播放器
  - main 侧新增 `mpv-controller.ts`（node-mpv 封装）
  - renderer 侧新增 `MusicPlayer.tsx`（独立 UI 组件，由 UI agent 负责绘制，本计划只负责 main 侧对接）
  - **mpv 为强制依赖**：打包/安装时强制用户装 mpv，**不做 orpheus:// fallback**（orpheus:// 检测代码仍保留但不作为降级路径）
- **`music_present_tracks` 删除**：发卡逻辑并入 search/daily，不保留轻量版
- **收藏功能**：M0 确认 OpenAPI 有收藏 endpoint 才做；若无则直接删掉 `isFavorite` 字段 + `toggleFavorite` action（UI 组件相应去掉收藏按钮），**不做本地状态降级**
- **歌词持久化缓存**：避免重复请求消耗 OpenAPI 配额
- **不做 CITA 止血**，等大重构一次性解决
- **节奏**：先出计划审阅，确认后再动手

### 1.2 目标

1. 废弃 Python 子进程（uv + pyncm + fastmcp + stdio MCP 协议层）
2. 废弃 CITA candidateRef 间接层，工具直接接原始 songId / playlistId
3. 直连官方 OpenAPI（RSA-SHA256 签名），TS 侧原生 fetch
4. 扫码登录改为调 OpenAPI QR endpoint，凭证从 MUSIC_U cookie 改为 accessToken
5. 播放路径从 orpheus:// 改为 mpv 子进程（node-mpv 控制）
6. 保持 renderer 侧核心契约（`MusicStatusSnapshot`、IPC 通道名），但播放器 UI 升级为独立 React 组件

### 1.3 不在范围

- MiniMax 文本格式 tool call（独立问题，另立项）
- orpheus:// 协议检测代码（保留但不再作为 fallback 路径，mpv 为强制依赖）
- UI 组件的具体视觉设计（由独立 UI agent 负责）

---

## 二、关键风险（必须在 M0 验证）

### 风险 1：endpoint 覆盖度

官方 ncm-cli README + skills 仓库 SKILL.md 已确认覆盖以下能力：

| Cyrene 现有工具 | 官方包是否有 | 证据来源 |
|---|---|---|
| music_search | ✅ | `ncm-cli search song --keyword` |
| music_get_daily_recommendations | ✅ | README 功能特性 |
| music_play_track | ✅ | `ncm-cli play --song --encrypted-id --original-id` |
| music_play_playlist | ✅ | SKILL.md 触发场景 |
| music_my_playlists | ✅ | assistant 文档 playlist collected |
| music_playlist_detail | ⚠️ 大概率 | assistant 用歌单 trackCount 字段，M0 确认 |
| music_create_playlist | ✅ | `ncm-cli playlist create --playlistName` |
| music_add_to_playlist | ✅ | assistant 明确流程 |
| music_my_subscriptions | ⚠️ 部分 | 红心歌单有，收藏的歌手/专辑未明确 |

**结论**：9 个工具里 7 个明确有，2 个待 M0 实测确认。若「我的收藏」不完整，可能要砍或降级该工具。

### 风险 2：5000 次/天配额

按 appId 计还是按用户计未确认。若按 appId 共享，多用户场景会撞；若按用户（每个用户自己申请的 appId）隔离，宽裕。M0 实测确认。

### 风险 3：device 字段合规

OpenAPI 示例 device 是智能手表参数（`andrwear`/`otos`/`hm`）。桌面 Electron 能否传 desktop 类参数，M0 实测。

### 风险 4：歌曲 ID 双字段

官方 SKILL.md 三次强调：搜索/歌单结果同时返回 **加密 ID（32 位 hex）+ 原始 ID（数字）**。
- 加密 ID 用于 API 请求（播放/加歌单）
- 原始 ID 用于拼可点击链接
- `visible: false` 的歌无法播放，必须过滤

**影响**：`MusicTrack` 类型要同时存两个字段；搜索/歌单工具返回 JSON 要包含这两个 ID；`music_play_track` 入参用加密 ID（API 用），UI 展示用原始 ID 拼链接。

### 风险 5：mpv 跨平台安装

mpv 为强制依赖（~30MB），打包/安装时强制用户装。Windows/macOS/Linux 路径不同，`mpv-controller.ts` 要做路径检测 + 缺失时清晰报错引导安装。不做 orpheus:// fallback。

### 风险 6：歌曲 URL 获取

mpv 播放需要真实的音频 URL。OpenAPI 是否提供「获取歌曲播放 URL」endpoint（类似 `/song/url/v1`），M0 实测确认。若无，mpv 路径走不通，需回退 orpheus://。

### 风险 7：歌词 endpoint

UI 契约要求 `Track.lyrics: {timeMs, text}[]`（LRC 解析后的升序时间轴）。OpenAPI 是否提供歌词 endpoint（返回原始 LRC 文本），M0 实测确认。若无，UI 歌词区显示「暂无歌词」占位，不阻塞重构。

### 风险 8：封面图防盗链

网易云封面 URL（`coverImgUrl`）可能有 Referer 鉴权，renderer 直接 `<img src>` 可能加载失败。需要在 main 侧加图片代理（带 Referer 头转发）。M0 实测确认是否真有防盗链。

### 风险 9：收藏状态来源

UI 契约有 `Track.isFavorite` + `toggleFavorite`。OpenAPI 是否提供「查询歌曲收藏状态」+「收藏/取消收藏」endpoint，M0 实测确认。**若无则直接删掉 `isFavorite` 字段 + `toggleFavorite` action，UI 组件相应去掉收藏按钮，不做本地状态降级**。

---

## 三、现状架构（要拆的部分）

```
ToolDefinition[] (music-tools.ts, 9 个工具)
  │  其中 4 个走 CITA：search / daily / present_tracks / play_track
  │  其余 5 个已接原始 ID
  ▼
MusicService (music-service.ts)
  ├─ 状态机：backend(stopped/starting/ready/failed/incompatible)
  ├─ SelectionSetCache（CITA 集合 + TTL 30min + presented 门控）
  ├─ LoginOrchestrator（QR 扫码 begin/check/cancel）  ← weapi QR，要重写
  ├─ CookieVault（MUSIC_U cookie 加密持久化）          ← 要改造存 token
  ├─ idle shutdown 10min（回收 Python 进程）
  └─ 校验：requireSignedIn / E_TRACK_NOT_PLAYABLE
  ▼
MusicRouter → NeteaseMusicProvider
  ▼
MusicMcpClient (music-mcp-client.ts)  ← stdio JSON-RPC，要拔
  ▼
Python 子进程 (vendor/cloud-music-mcp/)  ← uv + pyncm + fastmcp，要删
  ├─ 通道1：music.163.com/weapi/...（pyncm 加密）
  └─ 通道2：orpheus://base64（本地客户端播放）
```

---

## 四、目标架构

```
ToolDefinition[] (music-tools.ts, 8 个工具)  ← 去 CITA，全接原始 ID
  ▼
MusicService (music-service.ts)  ← 简化
  ├─ 状态机：backend(stopped/ready/failed)（无 starting，无 Python 启动）
  ├─ LoginOrchestrator（重写）  ← 调 OpenAPI QR endpoint，存 accessToken
  ├─ TokenVault（由 CookieVault 改造）  ← 存 accessToken，safeStorage 加密
  ├─ MpvController（新）  ← spawn mpv + node-mpv JSON IPC 控制播放
  ├─ LyricsCache（新）  ← 持久化缓存歌词，避免重复请求消耗配额
  └─ 校验：requireSignedIn（保留）/ 去 E_TRACK_NOT_PLAYABLE 门控
  ▼
MusicRouter → NeteaseOpenapiProvider (新)
  ▼
NeteaseOpenapiClient (新)  ← RSA-SHA256 签名 + fetch openapi.music.163.com
  │
  └─ 播放：MpvController.load(url)  ← 替代 orpheus://，无 fallback
```

**数据流（播放场景）**：
```
music_play_track(encryptedId)
  ▼
NeteaseOpenapiClient.getSongUrl(encryptedId)  ← 拿真实音频 URL
  ▼
MpvController.load(url)  ← mpv 子进程加载
  ▼
mpv 后台解码播放
  ▼
renderer MusicPlayer.tsx  ← 订阅 mpv 状态（position/pause/duration）显示 UI
```

---

## 五、工具映射表（旧 9 → 新 8）

| 旧工具 | 旧入参 | 新工具 | 新入参 | 变化 |
|---|---|---|---|---|
| music_get_daily_recommendations | () + CITA setRef/candidateRefs | music_get_daily_recommendations | () | 去 CITA，返回 tracks（含双 ID） + 直接发卡 |
| music_search | (keyword, purpose, limit) + CITA | music_search | (keyword, limit?) | 去 purpose，去 CITA，返回含**加密 ID + 原始 ID** 的 tracks + 发卡 |
| music_present_tracks | (candidateRefs[], reasons) | **删除** | — | 发卡逻辑并入 search / daily |
| music_play_track | (candidateRef) | music_play_track | (encryptedId) | candidateRef → 加密 ID（32 位 hex 校验）；内部调 getSongUrl + MpvController.load |
| music_play_playlist | (playlistId) | music_play_playlist | (playlistId) | 内部先拉歌单 tracks，再喂 MpvController |
| music_my_playlists | () | music_my_playlists | () | 不变 |
| music_playlist_detail | (playlistId) | music_playlist_detail | (playlistId) | 不变 |
| music_create_playlist | (name, privacy) | music_create_playlist | (name, privacy?) | 不变 |
| music_add_to_playlist | (playlistId, trackIds[]) | music_add_to_playlist | (playlistId, trackIds[]) | 不变 |
| music_my_subscriptions | (category) | music_my_subscriptions | (category) | 不变 |

**CITA 死因**：`music_play_track` 改接加密 ID 后，模型从 search 返回 JSON 里抄一个 32 位 hex 比抄不透明 candidateRef 字符串稳健得多——即便抄错也是清晰的「歌曲不存在」，不再是 `E_CONTEXT_REF_NOT_FOUND`。

---

## 六、文件变更清单

### 6.1 新增

| 文件 | 职责 |
|---|---|
| `src/main/music/netease-openapi-client.ts` | RSA-SHA256 签名 + fetch 封装 + endpoint 方法 |
| `src/main/music/netease-openapi-provider.ts` | 实现 `MusicProvider` 接口，调 openapi-client |
| `src/main/music/openapi-config.ts` | 读取 appId/privateKey（明文 config 文件，userData 下） |
| `src/main/music/openapi-result-normalizer.ts` | OpenAPI 响应 → 内部类型（MusicTrack 等） |
| `src/main/music/mpv-controller.ts` | node-mpv 封装：spawn + JSON IPC + 播放控制 + 状态事件 |
| `src/main/music/token-vault.ts` | 由 CookieVault 改造而来，存 accessToken（safeStorage 加密） |
| `src/main/music/lyrics-parser.ts` | LRC 文本 → `{timeMs, text}[]` 升序时间轴（纯函数，无 IO） |
| `src/main/music/lyrics-cache.ts` | 歌词持久化缓存（按 encryptedId key 落盘 userData，避免重复请求消耗配额） |
| `src/main/music/cover-proxy.ts` | 封面图代理：main 侧 HTTP endpoint 带 Referer 转发 `coverImgUrl`，防 renderer 防盗链失败（M0 确认有防盗链才做） |
| `src/renderer/components/MusicPlayer/` | UI 组件目录（由 UI agent 负责绘制，main 侧只负责对接） |
| `src/renderer/settings/music/config-panel.ts` | OpenAPI config 设置面板入口（填 appId/privateKey） |
| `src/main/music/types.ts` 内 `MusicTrack` 扩展 | 增加 `encryptedId` 字段（32 位 hex） |

### 6.2 修改

| 文件 | 改动 |
|---|---|
| `music-service.ts` | 去 MusicMcpClient/Python 生命周期；接新 provider；简化 backend 状态机（无 starting）；登录改为调 OpenAPI QR + TokenVault；去 SelectionSetCache 的 presented 门控；新增 MpvController 生命周期管理 |
| `bootstrap.ts` | 去 Python paths / portable-component |
| `music-tools.ts` | 重写，去 CITA，发卡直接用 tracks；`music_play_track` 改接 encryptedId + 内部调 getSongUrl + MpvController.load |
| `ipc-handlers.ts` | 登录相关 IPC 调整（OpenAPI QR）；新增 mpv 播放控制 IPC（play/pause/seek/volume/next/prev）；新增 UI 直连 IPC（MUSIC_SEARCH / MUSIC_GET_LYRICS / MUSIC_TOGGLE_FAVORITE） |
| `paths.ts` | 去 vendorDir / componentDir |
| `types.ts` | 标记 `MusicCandidateRefPayload` / `MusicSetRefPayload` 弃用或删除；`MusicTrack` 加 `encryptedId` / `lyrics`；**不加 `isFavorite`**（M0 确认无收藏 endpoint 则彻底删除该字段，UI 组件去掉收藏按钮） |
| `login-orchestrator.ts` | **重写**：weapi QR → OpenAPI QR endpoint；状态机语义保留（idle/creating_qr/waiting_scan/waiting_confirm/authorized/expired/cancelled/failed）；凭证改为 accessToken |
| `panel.ts`（renderer） | 二维码渲染 + 轮询逻辑保留，qrContent 来源改为 OpenAPI 短链；状态文案微调；**加 config 面板入口**（appId/privateKey 输入） |
| `protocol-detector.ts` | 保留但不再作为 fallback 路径（mpv 为强制依赖） |
| `shared/ipc-channels.ts` | 新增 UI 直连通道：`MUSIC_SEARCH` / `MUSIC_GET_LYRICS` / `MUSIC_COVER_PROXY`（`MUSIC_TOGGLE_FAVORITE` 视 M0 结果决定是否加） |
| `preload/music.ts` | 暴露新的 UI 直连 API（search / getLyrics / coverUrl；toggleFavorite 视 M0 结果） |

### 6.3 删除

| 文件/目录 | 理由 |
|---|---|
| `src/main/music/music-mcp-client.ts` | stdio MCP 通话层，整层蒸发 |
| `src/main/music/child-env.ts` | Python 子进程 env 构造 |
| `src/main/music/portable-component.ts` | Python 便携组件定位 |
| `src/main/music/cookie-vault.ts` | 被 token-vault.ts 取代 |
| `src/main/music/selection-set-cache.ts` | CITA 集合缓存（若 MusicService 不再需要 latest-set 则删） |
| `src/main/music/result-normalizer.ts` + `playback-result-normalizer.ts` | 被 openapi-result-normalizer 取代 |
| `vendor/cloud-music-mcp/` | 整个 Python 目录 |
| 依赖 `@modelcontextprotocol/sdk` | MCP 协议层 |
| 对应 `.test.ts` | 随实现一起清理/重写 |

### 6.4 保留

- `music-router.ts`（多 provider 抽象，廉价留用）
- `music-provider.ts`（接口）
- `protocol-detector.ts`（orpheus:// 检测，作 fallback）
- `types.ts` 核心类型（`MusicTrack` / `MusicPlaylist` / `MusicPlaylistDetail` / `MusicSubscription` / `PlaybackDispatchResult`）
- `smoke-codes.ts` / `music-smoke-entry.ts`（调整后保留）
- renderer 二维码渲染逻辑 + 轮询逻辑（qrContent 来源换 OpenAPI 短链）

---

## 七、里程碑（增量、每步可验证）

### M0 — 验证 spike（不碰生产代码）

**性质**：纯调研，产出文档，零生产代码改动。

1. 临时目录 `npm install @music163/ncm-cli --omit=optional`，拉出 bin 入口 + 命令实现源码
2. 用真实 appId/privateKey，逐个测 8 个目标 endpoint：
   - search / daily recs / my playlists / playlist detail / create playlist / add to playlist / my subscriptions / validate session
3. 实测 OpenAPI QR 登录 endpoint（begin/check/cancel），确认短链格式 + 轮询语义
4. **实测「获取歌曲播放 URL」endpoint**（风险 6），确认 mpv 路径可行性
5. **实测歌词 endpoint**（风险 7）：确认是否返回原始 LRC 文本，验证 lyrics-parser 可行性
6. **实测封面图防盗链**（风险 8）：renderer 直接 fetch `coverImgUrl` 是否 403，确认是否需要 cover-proxy
7. **实测收藏 endpoint**（风险 9）：查询收藏状态 + 收藏/取消收藏接口是否存在
8. 确认风险 1-9 的实际结局

**产出**：`docs/music-openapi-endpoints.md`（endpoint 映射表 + 签名实现参考 + auth 模型结论 + QR endpoint 文档 + getSongUrl 验证 + 歌词/封面/收藏 endpoint 验证 + device/quota 实测）。一个最小 TS PoC 脚本（签名 + 调通一个 endpoint + QR 登录 + getSongUrl）。

**验收**：
- 8 个 endpoint 至少 6 个可调通
- OpenAPI QR 登录链路验证通过（begin→check→拿到 accessToken）
- getSongUrl endpoint 验证存在且返回可用音频 URL（mpv 路径可行性确认）
- 歌词/封面/收藏 endpoint 各有明确结论（有/无/降级方案）
- 明确 device 字段 + 配额计费方式

### M1 — OpenAPI client + TokenVault（新文件，不删旧）

**性质**：新增 provider + 凭证存储，与旧实现并存，不接入 MusicService。

1. `netease-openapi-client.ts`：RSA-SHA256 签名 + fetch + endpoint 方法（含 search / getSongUrl / getLyrics / favorite 等 UI 直连用的方法）
2. `netease-openapi-provider.ts`：实现 `MusicProvider` 接口
3. `openapi-result-normalizer.ts`：响应归一化（含双 ID + visible；isFavorite 视 M0 结果）
4. `openapi-config.ts`：config 读取（从 renderer 设置面板写入的 userData config 文件）
5. `token-vault.ts`：由 CookieVault 改造，存 accessToken
6. `lyrics-parser.ts`：LRC 文本 → `{timeMs, text}[]`（纯函数，M0 确认有歌词 endpoint 才做）
7. `lyrics-cache.ts`：持久化缓存（按 encryptedId key 落盘 userData）
8. 单测：mock fetch 验证签名格式 + 各 endpoint 入参/归一化 + lyrics-parser 解析

**验收**：单测全绿；PoC 级别能调通真实 OpenAPI（用 M0 的 key）；lyrics-parser 能解析样例 LRC；lyrics-cache 读写正常。

### M2 — 重写 LoginOrchestrator（OpenAPI QR）

**性质**：登录链路重写，renderer UI 复用。

1. `login-orchestrator.ts` 重写：调 OpenAPI QR begin/check/cancel endpoint
2. 状态机语义保留（idle/creating_qr/waiting_scan/waiting_confirm/authorized/expired/cancelled/failed）
3. authorized 时拿 accessToken → TokenVault.persist()
4. renderer `panel.ts`：qrContent 来源改为 OpenAPI 短链，渲染/轮询逻辑不动
5. 启动时 TokenVault.load() → 注入 accessToken → 校验有效性

**验收**：renderer 扫码 → 拿到 accessToken → 用户级 endpoint 可调通。

### M3 — 重接 MusicService（接新 provider）

**性质**：切换底层 provider，工具层暂不动（仍走 CITA，但底层走 OpenAPI）。

1. `MusicService` 构造：用新 provider 替换 `MusicMcpClient + NeteaseMusicProvider`
2. 去 Python 启动逻辑 / idle shutdown
3. backend 状态机简化：`ready` = OpenAPI client 配置就绪（无 starting）
4. `bootstrap.ts` 去 Python paths
5. **MpvController 集成**：spawn mpv + node-mpv 封装 + IPC handler（play/pause/seek/volume/next/prev）
6. `music_play_track` / `music_play_playlist` 内部改调 MpvController（先 getSongUrl → 再 mpv.load）
7. **UI 直连 IPC 落地**（见第十节）：search / getLyrics / toggleFavorite / coverProxy
8. **cover-proxy 落地**（M0 确认有防盗链才做）：main 侧 HTTP 代理带 Referer 转发封面图
9. **MusicPlayer 组件集成**：把 UI agent 交付的 `player-demo/src/components/` 接入 Cyrene renderer，用真实 IPC 替换 App.tsx 的 mock 引擎

**验收**：现有 9 个工具仍可用（CITA 链暂时保留），底层已无 Python；mpv 能播放真实音频；renderer 播放器 UI 能控制播放 + 搜索 + 看歌词 + 看封面。

### M4 — 重写 music-tools（杀 CITA）

**性质**：工具层重写，按第五节映射表落地。

1. `music-tools.ts` 重写：去 `issueSelectionContext` / `presentAndPublish` 的 ref 发牌
2. `music_search` / `music_get_daily_recommendations`：直接返回 tracks（含双 ID）+ 调 `sendCard`
3. `music_play_track`：入参改 encryptedId（32 位 hex 校验），去 `E_TRACK_NOT_PLAYABLE` 门控，内部调 getSongUrl + MpvController.load
4. 删 `music_present_tracks`
5. 去所有 `ContextRefRegistry` / `controlledInput: context_ref` 用法
6. 重写对应单测

**验收**：search → play 两步走通，无 `E_CONTEXT_REF_NOT_FOUND`；8 个工具单测全绿。

### M5 — 清理死代码 + 集成验证

**性质**：删旧实现 + 端到端验证。

1. 删 `music-mcp-client.ts` / `child-env.ts` / `portable-component.ts` / `cookie-vault.ts` / `selection-set-cache.ts` / `result-normalizer.ts` / `playback-result-normalizer.ts`
2. 删 `vendor/cloud-music-mcp/` 整个目录
3. `package.json` 去 `@modelcontextprotocol/sdk`
4. 清理对应 `.test.ts`
5. 文档：去 uv 安装要求，**加 mpv 强制安装说明**（Windows/macOS/Linux 各平台安装方式）
6. **mpv 依赖检测**：`mpv-controller.ts` 启动时检测 mpv 是否存在，缺失时清晰报错引导安装（不做 orpheus:// fallback）
7. 端到端：search→play / daily→play / 歌单 CRUD / 收藏查询（mpv 播放控制全可用；收藏视 M0 结果）
8. renderer 音乐面板：状态快照、登录态、播放分发、config 面板
9. smoke 测试
10. 回归：非音乐功能不受影响

**验收**：`tsc` 无残留引用；构建通过；全链路手动验证通过；无孤儿导入；mpv 缺失时有清晰引导。

---

## 八、UI 组件分工（与独立 UI agent 的边界）

### 8.1 职责边界

- **UI agent 负责**：只画 React 组件，用 mock 数据展示各种状态，不管播放逻辑
- **本计划负责**：main 侧 mpv 接入 + IPC handler + 真实状态桥接到 renderer

### 8.2 UI agent 交付物

- `MusicPlayer.tsx`（主组件）+ 子组件 + 样式 + `types.ts` + stories/demo
- 组件要能用 mock 数据独立运行，不依赖真实 mpv 后端
- 详细对接契约（数据类型/状态/回调/设计要求/禁止事项）见对话中「音乐播放器 UI 组件 - 对接说明」一份完整说明，交付给 UI agent 时附上

### 8.3 接口契约要点

UI 组件通过 props 接收 `PlaybackState`（当前播放状态）和 `PlaybackActions`（命令回调），不直接接触 mpv 或 OpenAPI。

```typescript
interface MusicPlayerProps {
  state: PlaybackState;      // 当前播放状态（从 mpv 订阅）
  actions: PlaybackActions;  // 命令回调（发 IPC 到 main）
  variant?: "full" | "mini" | "bar";
}
```

**main 侧职责**：
- spawn mpv 子进程（`--idle --input-ipc-server`）
- node-mpv 订阅 mpv 事件（time-position/pause/duration 等）→ 推送 PlaybackState 到 renderer
- IPC handler 接收 PlaybackActions → 转发为 mpv 命令

---

## 十、UI 直连 IPC 契约（renderer ↔ main，不经 AI 工具层）

UI agent 交付的 `MusicPlayer` 组件除了播放控制外，还要求 4 个数据源：搜索结果、歌词、收藏状态、封面图。这些走 renderer → IPC → main → OpenAPI，**不经 AI 工具层**（用户在 UI 上操作不应消耗模型 token）。

### 10.1 IPC 通道清单

| 通道 | 方向 | 入参 | 出参 | 用途 |
|---|---|---|---|---|
| `MUSIC_SEARCH` | renderer → main | `{ query: string, limit?: number }` | `Track[]` | UI 搜索框输入（250ms 防抖后调） |
| `MUSIC_GET_LYRICS` | renderer → main | `{ encryptedId: string }` | `{ timeMs: number, text: string }[]` | 点唱片切歌词视图时调，走持久化缓存 |
| `MUSIC_TOGGLE_FAVORITE` | renderer → main | `{ encryptedId: string, favorite: boolean }` | `boolean`（新状态） | **M0 确认有收藏 endpoint 才加**，无则删除该通道 + UI 去掉收藏按钮 |
| `MUSIC_COVER_PROXY` | renderer → main | `{ url: string }` | `string`（代理后的 URL） | 封面图 `<img src>` 前转换（**M0 确认有防盗链才做**，无则 renderer 直连） |

### 10.2 各通道实现要点

**MUSIC_SEARCH**：
- main 侧调 `NeteaseOpenapiClient.search(keyword, limit)`
- 复用 `openapi-result-normalizer` 归一化
- 返回的 `Track[]` 含 `encryptedId` + `originalId` + `coverImgUrl` + `visible`
- 空 query 直接返回 `[]`（renderer 已做防抖，但 main 兜底）

**MUSIC_GET_LYRICS**：
- 先查 `lyrics-cache.ts`（持久化缓存，按 encryptedId key 落盘 userData）
- 缓存未命中 → 调 `NeteaseOpenapiClient.getLyrics(encryptedId)` → 拿原始 LRC 文本 → 经 `lyrics-parser.ts` 解析成 `{timeMs, text}[]` → 写入缓存
- 无歌词 endpoint 或解析失败 → 返回 `[]`，UI 显示「暂无歌词」
- 持久化缓存避免重复请求消耗配额

**MUSIC_TOGGLE_FAVORITE**（M0 确认有收藏 endpoint 才做）：
- 调真实 OpenAPI API，返回新状态
- `isFavorite` 初始状态来源：歌单/搜索结果归一化时从 OpenAPI 响应字段填
- **M0 确认无收藏 endpoint → 删除该通道 + 删除 `Track.isFavorite` 字段 + UI 组件去掉收藏按钮，不做本地状态降级**

**MUSIC_COVER_PROXY**（M0 确认有防盗链才做）：
- main 侧起一个本地 HTTP endpoint（如 `http://localhost:<port>/music-cover/<base64url>`）
- 收到请求后带 `Referer: https://music.163.com` 转发到真实 `coverImgUrl`
- 返回图片字节流给 renderer
- renderer 侧 `coverImgUrl` 经 `coverProxy(url)` 转换后喂 `<img src>`
- **M0 确认无防盗链 → 删除该通道 + 删除 cover-proxy.ts，renderer 直接用原 URL**

### 10.3 preload 暴露的 API

```typescript
// preload/music.ts 新增
export interface MusicUiApi {
  search(query: string, limit?: number): Promise<Track[]>;
  getLyrics(encryptedId: string): Promise<{ timeMs: number; text: string }[]>;
  // toggleFavorite: M0 确认有收藏 endpoint 才暴露
  // coverProxy: M0 确认有防盗链才暴露
}

// window.music.ui 暴露
```

### 10.4 与 AI 工具层的关系

| 场景 | 走 AI 工具层 | 走 UI 直连 IPC |
|---|---|---|
| 用户对 AI 说"帮我找周杰伦的歌" | ✅ `music_search` 工具 | ❌ |
| 用户在 UI 搜索框输入"周杰伦" | ❌ | ✅ `MUSIC_SEARCH` |
| AI 调 `music_play_track` 播歌 | ✅ | ❌ |
| 用户点 UI 播放按钮 | ❌（走 PlaybackActions） | ❌（走 mpv IPC） |
| 用户点收藏按钮（若有） | ❌ | ✅ `MUSIC_TOGGLE_FAVORITE`（M0 确认有才存在） |
| AI 发卡片显示搜索结果 | ✅ `music_search` + sendCard | ❌ |

**原则**：AI 工具层和 UI 直连 IPC 各走各的，共享同一个 `NeteaseOpenapiClient`，不共享调用路径。

---

## 十一、已确认的决策

1. **config 存放方式**：加一个 renderer 设置面板入口让用户填 appId/privateKey
2. **`music_present_tracks` 删除**：我推荐删除——发卡逻辑并入 search/daily 后没有保留必要，保留轻量版只是多一个不常用工具增加维护成本
3. **里程碑顺序**：M0→M5 认可
4. **mpv 依赖策略**：打包/安装依赖时强制用户装 mpv，不做 fallback 到 orpheus://
5. **UI 组件交付时机**：看 M3 节奏，M3 集成让 mpv 路径有 UI 可验证
6. **收藏语义**：M0 确认 OpenAPI 无收藏 endpoint → 直接删掉 `isFavorite` 字段 + `toggleFavorite` action（UI 组件要相应去掉收藏按钮）
7. **歌词缓存策略**：持久化缓存（避免重复请求消耗配额）

---

> 计划状态：决策已确认。从 M0 开始。
