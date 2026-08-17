# Cyrene 音乐工具链路分析：问题、上游与实现

> 调研时间：2026-08-17
> 范围：从模型工具调用（TS 侧 music-tools）到 Python 后端（cloud-music-mcp）的整条链路
> 目的：为「是否重构音乐系统」决策提供事实依据

## 摘要

当前音乐工具链存在两层独立问题，不应混为一谈：

1. **TS 侧工具链问题**：`music_search → music_play_track` 强制经过 CITA candidateRef 间接层，模型经常抄错 ref 或误以为 `purpose=play` 就已完成播放，导致 `E_CONTEXT_REF_NOT_FOUND` 报错和"已播放但没调工具"的现象。
2. **上游 Python 后端问题**：用户必须装 uv + 拉起 Python 子进程，pyncm 被 pin 在某个 fork commit（说明上游有 bug），MCP 协议层带来额外开销。

Python 后端实际只是"会做 weapi 加密的中间人"。上游真正打交道的是 music.163.com 自己的内部 web API + 本地网易云桌面客户端的 `orpheus://` URL Scheme——这两条通道都跟 Python 无关，理论上可以在 TS 侧直接复刻。

---

## ⚠️ 重大更新（2026-08-17）

**前文第一至四章基于"网易没有公开官方 API"的前提写的，这个前提被推翻**。用户在 [developer.music.163.com](https://developer.music.163.com) 申请入驻后发现：网易有完整的官方 OpenAPI、官方 CLI（`@music163/ncm-cli`）、官方 AI Agent Skills 仓库（[github.com/NetEase/skills](https://github.com/NetEase/skills)）。

**新结论**：之前讨论的 weapi 逆向工程、pyncm JS 替代、port 加密算法等所有难题，被官方路径一次性绕开。详见本文档第五、六、七章。

第一至四章保留作为现状分析的历史记录；做决策请以第五至七章为准。

---

## 一、当前音乐工具侧的问题（TS 侧）

### 1.1 工具链结构

[bootstrap.ts](file:///e:/Cyrene-Agent/src/main/music/bootstrap.ts) 通过 `buildMusicTools()` 把 9 个音乐工具注册进 `toolRegistry`，由 Harness 的 function calling 循环暴露给模型。每个工具的 `execute()` 内部调 `MusicService`，`MusicService` 经 `MusicMcpClient` 走 stdio 跟 Python 子进程通信。

模型侧使用的是 OpenAI 的 `tools`/`tool_calls` 协议（[openai-adapter.ts](file:///e:/Cyrene-Agent/src/main/orchestrator/vendors/openai-adapter.ts) 把每个工具序列化成 `{ type: "function", function: {...} }`）。**这本身就是 function calling 的新版形态**——OpenAI 旧的 `functions`/`function_call` 字段已废弃，本项目未实现那条老路。

### 1.2 已观测症状

#### 症状 A：搜完播放报 `E_CONTEXT_REF_NOT_FOUND`，但第二次播放成功

调用链：`music_search(keyword, purpose=play)` 成功 → `music_play_track(candidateRef)` 失败 → 重试成功。

报错出处：[context-ref-registry.ts:60](file:///e:/Cyrene-Agent/src/main/orchestrator/context-ref-registry.ts#L60)

```ts
resolve<T>(contextRef, conversationId, expectedKind) {
  const entry = this.entries.get(contextRef);
  if (!entry) throw new Error("E_CONTEXT_REF_NOT_FOUND");  // ← 这里
}
```

模型传进来的 ref 在 registry 里查不到。触发条件：
- 模型**编了一个 ref**（最常见——模型不愿留空就瞎填）
- ref 被 LRU 淘汰或 TTL 过期（每会话有上限 + 30 分钟 TTL，见 [music-service.ts](file:///e:/Cyrene-Agent/src/main/music/music-service.ts) 中 `SET_TTL_MS = 30 * 60_000`）
- conversationId 不匹配（罕见）

#### 症状 B："已播放"但没调 `music_play_track`

模型搜完几首歌后，用户说"播第一首"，模型直接回复"已播放"，**根本没调 `music_play_track` 工具**。

根因：[music-tools.ts:224](file:///e:/Cyrene-Agent/src/main/orchestrator/tools/music-tools.ts#L224) 的 description 文案：

```
purpose=play 用于本轮搜索确认后直接播放唯一结果
```

模型读字面意思以为"purpose=play 就等于播放了"，于是不调 `music_play_track`。**description 文案与实际行为不一致**——实际上 `music_search` 在任何分支都不直接播放（[music-tools.ts:244-268](file:///e:/Cyrene-Agent/src/main/orchestrator/tools/music-tools.ts#L244-L268)），永远需要二次调 `music_play_track`。

#### 症状 C：MiniMax 模型吐文本格式 tool call

模型返回：

```
]<]minimax[>[<invoke name="music_search">]<]minimax[>[<keyword>Leave Me Alone TC]<]minimax[>[</keyword>]<]minimax[>[<purpose>play]<]minimax[>[</purpose>]<]minimax[>[</invoke> ]<]minimax[>[
```

这是 MiniMax 模型**没用 `tool_calls` 协议字段、改用纯文本吐工具调用**的产物（`]<]minimax[>[` 是它内部的特殊 token 漏到可见文本里）。OpenAI 兼容 adapter 收到的是文本而不是结构化 `tool_calls`，dispatch 根本没触发。

**这跟 CITA 无关**，是 adapter/模型侧的另一条独立坑——某些模型不严格遵守 OpenAI 的 function calling wire 格式。

### 1.3 根因：CITA 间接层的脆弱性

`music_search` 的 execute 永远不直接播放，只发牌（[music-tools.ts:244-268](file:///e:/Cyrene-Agent/src/main/orchestrator/tools/music-tools.ts#L244-L268)）：

```ts
// 三个分支都没有自动播放：
// - purpose=discover → 展示卡片，模型还得自己调 play
// - purpose=play + 多结果 → 展示卡片，模型还得自己调 play
// - purpose=play + 单结果 → 连卡片都不展示，模型还得自己调 play
return JSON.stringify({ kind: "search", context: safeContext, presentation });
```

模型必须做三步，**一步都不能错**：

1. 调 `music_search`
2. 从返回 JSON 里**精确提取** `context.candidates[i].candidateRef`（一个不透明字符串）
3. 调 `music_play_track`，把 candidateRef **原样回传**

CITA 强制模型做"读 JSON → 抄字符串"这个动作，模型经常抄错、截断或编造。这是症状 A 的主要诱因；症状 B 是 description 文案诱导模型偷懒；两者叠加使音乐工具链对模型的协同要求过高。

---

## 二、上游 Python 后端的问题

### 2.1 用户环境依赖

用户必须：
- 安装 **uv**（Python 包管理器）
- 首次使用音乐功能时由 [bootstrap.ts](file:///e:/Cyrene-Agent/src/main/music/bootstrap.ts) 拉起一个 **Python 子进程**（`cloud-music-mcp`）

这带来三个问题：
- **首次启动门槛高**：用户要先装 uv，否则音乐功能直接不可用
- **冷启动延迟**：Python 进程启动 + pyncm + fastmcp 加载有可见延迟
- **额外运行时占用**：一个长期 Python 进程驻留内存（虽然有 10 分钟空闲超时回收，见 [music-service.ts](file:///e:/Cyrene-Agent/src/main/music/music-service.ts) 中 `MUSIC_IDLE_TIMEOUT_MS = 10 * 60_000`）

### 2.2 pyncm 的 fork pin

[pyproject.toml:10](file:///e:/Cyrene-Agent/vendor/cloud-music-mcp/pyproject.toml#L10)：

```toml
"pyncm @ git+https://github.com/Code-MonkeyZhang/pyncm.git@26fda90ba874b652885458b89b92045ff88a8eef",
```

pyncm 不是从 PyPI 拉的稳定版本，而是 pin 在某个 fork 仓库的特定 commit。**这意味着上游 pyncm 有 bug，作者 fork 改过**。任何替换方案（无论是用 JS 库还是自己 port）都要验证这个 fix 有没有覆盖到，否则会踩同样的坑。

### 2.3 MCP 协议层的额外开销

Python 后端用 `fastmcp` 把函数包成 MCP tool，TS 侧用 `@modelcontextprotocol/sdk` 通过 stdio JSON-RPC 调用。这层协议本身是冗余的——它存在的唯一原因是"选了 MCP 当 IPC"。

具体开销：
- **依赖膨胀**：Python 侧引入 `mcp[cli]`、`fastmcp`；TS 侧引入 `@modelcontextprotocol/sdk`
- **协议转换**：每个调用要经过 MCP `callTool` envelope 包装/解包（见 [music-mcp-client.ts](file:///e:/Cyrene-Agent/src/main/music/music-mcp-client.ts) 的 `unwrapMcpResult`）
- **错误传播链长**：Python 异常 → MCP `isError: true` → TS `unwrapMcpResult` 抛 `E_MCP_TOOL_FAILED` → 上层捕获
- **契约校验额外层**：[music-mcp-client.ts](file:///e:/Cyrene-Agent/src/main/music/music-mcp-client.ts) 自己维护 `DATA_TOOL_CONTRACT` 和 `AUTH_TOOL_CONTRACT`，跟 MCP 服务端 schema 重复

删掉 Python 后整层 MCP 都可蒸发，TS 侧直接调原生网易云客户端即可。

---

## 三、上游 Python 后端的实现

### 3.1 实际规模

| 文件 | 行数 | 真正在做什么 |
|---|---|---|
| [api.py](file:///e:/Cyrene-Agent/vendor/cloud-music-mcp/src/cloud_music_mcp/api.py) | 265 | 9 个函数，每个都是"调 pyncm + 重新拼 JSON"。**没有真正的业务逻辑**。 |
| [auth.py](file:///e:/Cyrene-Agent/vendor/cloud-music-mcp/src/cloud_music_mcp/auth.py) | 354 | 一半是 Cyrene 不要的旧 PNG 二维码登录（`login_via_qrcode`）；一半是 Cyrene 非阻塞登录 patch（`begin_login`/`check_login`/`cancel_login`/`validate_session_three_state`），已经是返回结构化 dict 的纯逻辑。 |
| [main.py](file:///e:/Cyrene-Agent/vendor/cloud-music-mcp/src/cloud_music_mcp/main.py) | 280 | 纯 FastMCP 胶水，把 api.py 的函数包成 MCP tool。**删 Python 后整文件消失**。 |

Python 后端的实际依赖（pyproject.toml）：

| 依赖 | 用途 | 删 Python 后是否还需要 |
|---|---|---|
| `pyncm` (fork) | 网易云 weapi 加密 + endpoint 定义 + session/cookie | **必须替换**——这是唯一真正的硬骨头 |
| `mcp[cli]` + `fastmcp` | MCP server 框架 | 不需要（IPC 层消失） |
| `qrcode` + `Pillow` | 旧版 PNG 二维码登录 | 不需要（Cyrene patch 已绕过，返回 qr 文本内容即可） |
| `requests` | pyncm 内部 HTTP | 不需要（TS 用 fetch） |

### 3.2 上游是两个独立通道，别混在一起

这是理解整个系统的关键。Python 后端实际打交道的上游有**两条完全独立的通道**：

- **通道 1（数据获取）**：直连 `music.163.com` 自己的内部 web API，走 HTTP + weapi 加密
- **通道 2（播放）**：调本地网易云桌面客户端的 `orpheus://` URL Scheme，**完全不走 HTTP**

### 3.3 通道 1：数据获取 = 直连 music.163.com 内部 web API

Python 后端**不是接的什么"第三方音乐 API 服务商"**，它直接打 music.163.com 网页版播放器自己用的那套加密接口。pyncm 做的就是把这套加密协议翻译好，让 Python 能像浏览器里的网易云网页版一样发请求。

这些 URL 都是 `music.163.com/weapi/...`，跟你浏览器打开网页版网易云、F12 看网络请求是同一批接口。**pyncm 不是代理，是"把网页版的加密协议在 Python 里复刻一遍"**。

从 [api.py](file:///e:/Cyrene-Agent/vendor/cloud-music-mcp/src/cloud_music_mcp/api.py) 能看到的实际端点映射：

| pyncm 调用 | 实际命中的 weapi 端点 | 干啥 |
|---|---|---|
| `apis.WeapiCryptoRequest` + `/weapi/v1/discovery/recommend/songs` | 同名 | 每日推荐 |
| `apis.cloudsearch.GetSearchResult` | `/weapi/cloudsearch/get/web` | 搜索（歌曲/专辑/歌手/歌单） |
| `apis.user.GetUserPlaylists` | `/weapi/v1/user/playlist` | 我的歌单 |
| `apis.playlist.GetPlaylistInfo` | `/weapi/v6/playlist/detail` | 歌单详情 |
| `apis.playlist.SetCreatePlaylist` | `/weapi/v6/playlist/create` | 建歌单 |
| `apis.playlist.SetManipulatePlaylistTracks` | `/weapi/v6/playlist/manipulate/tracks` | 加歌进歌单 |
| `apis.album.GetAlbumInfo` | `/weapi/v1/album/detail/dynamic` | 专辑详情 |
| `apis.artist.GetArtistDetails` | `/weapi/v1/artist/desc` 等 | 歌手详情 |
| `apis.user.GetUserArtistSubs` / `GetUserAlbumSubs` | `/weapi/v1/artist/sub` 等 | 我的收藏 |
| `apis.login.LoginQrcodeUnikey` / `LoginQrcodeCheck` | `/weapi/login/qrcode/unikey` 等 | 扫码登录 |
| `apis.login.GetCurrentLoginStatus` | `/weapi/w/nuser/account` | 登录态校验 |

### 3.4 weapi 加密

网易云的 weapi 协议是 reverse engineering 出来的，核心算法是公开的：

- **AES-CBC** 加密请求 body（固定 key + 固定 iv）
- **RSA** 加密随机生成的 secKey，附在请求里
- **base64** + 固定变种编码

pyncm 把这套在 Python 里复刻。在 TS 侧实现这套算法不复杂（核心约 100 行），但维护成本全在自己——网易随时可能改协议。

### 3.5 通道 2：播放 = orpheus:// URL Scheme，完全不走 HTTP

看 [main.py:192-237](file:///e:/Cyrene-Agent/vendor/cloud-music-mcp/src/cloud_music_mcp/main.py#L192-L237) 的 `cloud_music_play`：

```python
command = {"type": type, "id": str(id), "cmd": "play"}
json_str = json.dumps(command, separators=(",", ":"))
encoded = base64.b64encode(json_str.encode("utf-8")).decode("utf-8")
app_url = f"orpheus://{encoded}"   # ← 这才是核心
os.startfile(app_url)              # Windows
subprocess.run(["open", app_url])  # macOS
```

**播放根本不打 music.163.com 的接口**。它把 `{"type":"song","id":"123","cmd":"play"}` 这个 JSON base64 一下，拼成 `orpheus://{base64}` 这个 URL Scheme，扔给系统去打开。

`orpheus://` 是网易云**桌面客户端**注册的协议，系统看到这个 URL 就唤起本地装的网易云客户端去播那首歌。

**关键约束**：
- 必须有网易云桌面客户端装在用户机器上（不然 `orpheus://` 没人响应）
- Python 这里只是构造 URL + `os.startfile`，**没有任何 HTTP 调用**
- 如果本地没装客户端，代码 fallback 到 `https://music.163.com/#/song?id=xxx` 让浏览器打开网页版

这一段迁到 TS 反而比 Python 还简单——Electron 直接 `shell.openExternal('orpheus://...')`，一行搞定，连 `os.startfile` / `subprocess.run(["open",...])` 那套平台分支都不用写。

### 3.6 登录流程

[auth.py](file:///e:/Cyrene-Agent/vendor/cloud-music-mcp/src/cloud_music_mcp/auth.py) 的 Cyrene 非阻塞登录 patch（`begin_login` / `check_login` / `cancel_login`）：

1. `begin_login`：调 `apis.login.LoginQrcodeUnikey(1)` 拿 unikey → 存进 `_PENDING_SESSIONS` dict → 返回 `{ loginSessionId, qrContent, expiresAt, pollIntervalMs }`
2. `check_login(session_id)`：调 `apis.login.LoginQrcodeCheck(uuid)` → 根据 code 返回 `waiting_scan` / `waiting_confirm` / `authorized` / `expired`
3. `authorized` 时：从 `GetCurrentSession().cookies.get_dict()` 拿 cookies → 原子写入 `<CYRENE_MUSIC_STORAGE_DIR>/cookies.json`
4. `cancel_login`：从 `_PENDING_SESSIONS` 弹出

登录态恢复走 `ensure_runtime_session()`：直接读本地 `cookies.json`，把 `MUSIC_U` cookie 注入 pyncm 的全局 session。**无网络请求**——有效性由后续 API 调用本身验证。

TS 侧已有现成基础设施对应：
- [cookie-vault.ts](file:///e:/Cyrene-Agent/src/main/music/cookie-vault.ts) — cookie 持久化
- [login-orchestrator.ts](file:///e:/Cyrene-Agent/src/main/music/login-orchestrator.ts) — 登录状态机

迁过来基本是机械翻译，且 Node 单线程异步模型比 Python 的 `threading.Lock` 更简单。

### 3.7 上游依赖图

```
┌─────────────────────────────────────────────────────────────┐
│ Cyrene TS (Electron 主进程)                                  │
│   ├─ netease-music-provider.ts  ← 已经是干净的接口层         │
│   └─ music-mcp-client.ts        ← stdio 通话管子（要拔的）  │
└────────────┬────────────────────────────────────────────────┘
             │ stdio JSON-RPC (MCP 协议)
┌────────────▼───────────────────────────────────────────────┐
│ Python 进程 (cloud-music-mcp)                               │
│   ├─ api.py      ← 9 个函数，每个就是"调 pyncm + 拼JSON"   │
│   ├─ auth.py     ← 扫码登录 + cookie 持久化                │
│   └─ main.py    ← FastMCP 胶水（删 Python 后整文件消失）   │
└────────────┬───────────────────────────────────────────────┘
             │
   ┌─────────┴───────────┐
   │                     │
   ▼ weapi 加密          ▼ URL Scheme
   HTTP+cookie           orpheus://base64
   ▼                     ▼
music.163.com/weapi/...  本地网易云桌面客户端
（网页版用的那套接口）    （必须用户本地已装）
```

---

## 四、对决策的影响

把两层问题合到一起看：

1. **TS 重写不需要"找一个新的音乐 API 服务商"**。上游就是 music.163.com 自己的 weapi 接口 + `orpheus://` URL scheme，跟 Python 无关。Python 只是"会做 weapi 加密的中间人"。

2. **weapi 加密本身是公开算法**（AES-CBC + RSA + base64 变种），网上能找到大量实现。pyncm 自己也是 reverse engineering 出来的。

3. **TS 侧大半架构已经存在**：[netease-music-provider.ts](file:///e:/Cyrene-Agent/src/main/music/netease-music-provider.ts) 是干净的接口层，[music-router.ts](file:///e:/Cyrene-Agent/src/main/music/music-router.ts)、[cookie-vault.ts](file:///e:/Cyrene-Agent/src/main/music/cookie-vault.ts)、[login-orchestrator.ts](file:///e:/Cyrene-Agent/src/main/music/login-orchestrator.ts)、[selection-set-cache.ts](file:///e:/Cyrene-Agent/src/main/music/selection-set-cache.ts)、[result-normalizer.ts](file:///e:/Cyrene-Agent/src/main/music/result-normalizer.ts) 这些都不用动。唯一要换的是 [music-mcp-client.ts](file:///e:/Cyrene-Agent/src/main/music/music-mcp-client.ts)（stdio MCP 通话），把它换成"直接调 TS 原生网易云客户端"。

4. **播放那一路最省事**：Electron 的 `shell.openExternal('orpheus://...')` 一行就替代了 Python 的 `os.startfile` + `subprocess.run(["open",...])` 那套平台分支。

5. **pyncm 的 fork pin 是迁移最大风险点**：迁到任何 JS 替代库都要验证这个 fix 有没有覆盖到，否则会踩同样的坑。

---

## 附：未决问题清单（已被第五至七章取代，保留作历史记录）

- [x] pyncm 用什么替换？候选：现成 JS 网易云库（license/维护状态/endpoint 覆盖度待调研）/ 自己 port pyncm（weapi 加密 + endpoint 定义，1-2 周）/ 混合方案（保留 pyncm 但去掉 MCP 协议层）
  - **2026-08-17 修订**：放弃所有 weapi 路径，改走官方 OpenAPI。详见第五至七章。
- [ ] 是否先做 CITA 工具流止血（改 `music_search` 单结果直连播放 + 修 description 文案），独立于 Python 迁移
  - **2026-08-17 修订**：仍有效。无论是否迁移到 OpenAPI，CITA candidateRef 间接层的脆弱性都要单独解决。
- [ ] MiniMax 文本格式 tool call 的 adapter 层修复，独立于音乐工具链

---

## 五、重大发现：官方 OpenAPI + ncm-cli 路径（2026-08-17）

### 5.1 背景

前文判断"网易没有公开的官方 API"是错的。用户在 [developer.music.163.com](https://developer.music.163.com) 申请入驻后，发现了完整的官方生态：

1. **官方 OpenAPI 平台**：`openapi.music.163.com/openapi/...`，OAuth2 + RSA_SHA256 签名
2. **官方 CLI**：[`@music163/ncm-cli`](https://www.npmjs.com/package/@music163/ncm-cli)，MIT 许可，2 个月前发布，活跃迭代
3. **官方 AI Agent Skills 仓库**：[github.com/NetEase/skills](https://github.com/NetEase/skills)，网易自己在 GitHub 上发布

`@music163/ncm-cli` 的 npm 维护者邮箱为 `grp.music-fe@corp.netease.com`（网易企业邮箱），scope `@music163/` 是网易官方 npm scope。**这不是社区第三方库，是网易官方发布**。

### 5.2 官方 OpenAPI vs 当前 weapi 路径

| 维度 | 官方 OpenAPI（新发现） | 当前 weapi（pyncm 用的） |
|---|---|---|
| 域名 | `openapi.music.163.com/openapi/...` | `music.163.com/weapi/...` |
| 性质 | **官方 sanctioned**，OAuth2 + RSA_SHA256 签名 | **reverse engineering**，模拟网页版加密 |
| 认证 | `appId` + `privateKey`（RSA 签名）+ 用户 QR 登录 | `MUSIC_U` cookie（扫码后从 session 拿） |
| 加密 | 不加密 body，靠 RSA_SHA256 签名保证完整性 | AES-CBC + RSA + base64 加密整个 body |
| 二维码登录返回 | `qrCodeUrl: "https://163cn.tv/..."` 短链 + `uniKey` | `qrContent: "https://music.163.com/login?codekey=..."` 长链 |
| 轮询 key | `uniKey`（UUID 格式） | `unikey`（短串） |
| 参数封装 | 业务参数塞进 `bizContent` JSON | 直接 form 字段 |
| 设备参数 | 强制 `device` 字段（deviceType/os/appVer/channel/model/deviceId/brand/osVer） | 不要求 |
| 限流/合规 | 有，受官方规则约束 | 没有，随时可能被风控 |
| 配额 | **5000 次/天**（按 appId 计） | 无硬上限，有反爬风控 |

### 5.3 pyncm 不走 OpenAPI 配额的证明

pyncm 用的是 weapi 体系，**和 OpenAPI 平行存在、互不相干**。铁证在 [api.py:12-17](file:///e:/Cyrene-Agent/vendor/cloud-music-mcp/src/cloud_music_mcp/api.py#L12-L17)：

```python
@apis.WeapiCryptoRequest  # ← weapi 加密装饰器
def GetDailyRecommendInternal():
    return "/weapi/v1/discovery/recommend/songs", {...}  # ← weapi 路径
```

pyncm 里根本没有 `appId`/`appSecret` 字段——它模拟浏览器扫码登录，拿到 `MUSIC_U` cookie 之后，伪装成网页版用户去发请求。这条路：

- 不需要任何官方资质
- 不占 OpenAPI 的 5000/天配额
- 但理论上能被反爬风控（验证码、限流、封号）

### 5.4 ncm-cli 是什么

[`@music163/ncm-cli`](https://www.npmjs.com/package/@music163/ncm-cli) 是网易官方发布的命令行音乐工具，基于官方 OpenAPI。

**关键事实**：

| 维度 | 值 |
|---|---|
| npm 包名 | `@music163/ncm-cli` |
| 当前版本 | 0.1.6 |
| 发布时间 | 2 个月前 |
| 周下载量 | 603 |
| License | **MIT**（可商用、可学习、可改造） |
| 维护者 | `grp.music-fe@corp.netease.com`（网易企业邮箱） |
| 运行时 | Node.js ≥18 |
| API 体系 | **官方 OpenAPI**（不是 weapi） |
| 播放后端 | **mpv**（开源、跨平台、~30MB，**替代 orpheus:// 的强依赖**） |
| AI Agent 集成 | **官方明确支持**，README 写"通过 Claude Code 或 OpenClaw 等 AI Agent 工具，可以使用自然语言进行音乐操作" |

**核心能力**：搜索歌曲/歌单/专辑、歌单管理（创建/添加/查看）、每日推荐、用户信息、TUI 播放器（旋转唱片 + 歌词 + 场景）、云盘上传（音频 + 通用文件）、播客管理、笔记发布。

**认证模式**：appId + privateKey（RSA 签名，2-legged）+ 用户 QR 扫码登录（用户 context）。**注意**：和你贴的 OpenAPI QR 登录文档示例 appId+appSecret+accessToken 三段式不一样——ncm-cli 用 appId+privateKey 两段式，privateKey 就是 RSA 签名用的私钥，不需要 accessToken。

### 5.5 官方 AI Agent Skills 仓库

[github.com/NetEase/skills](https://github.com/NetEase/skills) 是网易自己在 GitHub 上发布的 skills 仓库，专门给 AI Agent 用。三个 skill 分层依赖：

```
netease-music-assistant（智能助手：偏好分析、智能推荐）
   │ 调用
   ▼
netease-music-cli（CLI 操作层：搜索/歌单/每日推荐/用户信息）
   │ 依赖
   ▼
ncm-cli-setup（安装配置 ncm-cli）
```

`netease-music-cli` 覆盖能力：**搜索歌曲/歌单/专辑、歌单管理（创建/添加/查看）、每日推荐、用户信息**——和 Cyrene 当前 music-tools 的 9 个工具基本对齐。

仓库 100% Python（skills 是 prompt 工程，不是真的 Python 代码），但底层调用都是 `ncm-cli` 命令。

### 5.6 对前文判断的修订

| 前文章节 | 原判断 | 修订后判断 |
|---|---|---|
| 3.1 网易云没有公开官方 API | 网易没有公开官方 API 文档 | ❌ 错。有官方 OpenAPI 平台 + 官方 CLI + 官方 skills |
| 3.3 上游是 music.163.com 的 weapi 接口 | pyncm 直连 weapi | ✅ 对，但只是众多路径之一；官方 OpenAPI 是另一条平行路径 |
| 3.5 播放必须依赖 orpheus:// 桌面客户端 | orpheus:// 是唯一播放路径 | ❌ 不再唯一。ncm-cli 用 mpv，更轻量、可 bundle |
| 4.1 TS 重写不需要找新服务商 | 上游就是 music.163.com weapi | ✅ 对，但有更优选择：直接走官方 OpenAPI |
| 4.3 TS 大半架构已存在 | netease-music-provider 等可复用 | ✅ 仍对，新路径下复用度更高 |
| 4.5 pyncm fork pin 是迁移最大风险点 | 迁移要验证 fork fix 覆盖 | ⚠️ 失效。改走 OpenAPI 后 pyncm 整个废弃，不再有迁移风险 |

---

## 六、修订后的决策与建议

### 6.1 三条集成路径

| 方案 | 做法 | 工作量 | 优劣 |
|---|---|---|---|
| **A. 子进程方式** | 类似当前 Python：spawn `ncm-cli` 进程，stdin/stdout 通信；TS 侧 `netease-music-provider.ts` 改成调子进程 | 1-2 天 | 最快，无 uv 无 Python；但还是有一层进程通信，需要用户装 ncm-cli 全局 |
| **B. 直接调 OpenAPI** | 不用 ncm-cli 子进程，TS 侧直接 RSA 签名 + fetch OpenAPI；参考 ncm-cli 源码学 | 3-5 天 | 最干净，零中间层；但要自己处理签名细节 |
| **C. 改造官方 skills 为 Cyrene tools** | 把 [NetEase/skills](https://github.com/NetEase/skills) 里的 `netease-music-cli` 翻成 Cyrene 的 `ToolDefinition[]` 注册进 `toolRegistry` | 3-5 天 | 最贴合 Cyrene 工具架构；模型工具调用走 native function calling，不再有 CITA 链脆弱问题 |

### 6.2 推荐方案：C 为主线 + A 兜底

**主线（方案 C）**：

- 参考 ncm-cli 源码 + 官方 skills 的 prompt 设计，把音乐能力直接重写成 Cyrene 的 `ToolDefinition[]`，调底层 OpenAPI
- 不再依赖 CITA candidateRef 间接层——工具直接接 songId/playlistId 原始 ID，模型一步到位
- 不再 spawn 子进程——直接 fetch OpenAPI
- **同时根治第一、二章列出的 CITA 链脆弱问题**：candidateRef 间接层在新工具集里根本不出现

**兜底（方案 A）**：

- 如果某些 endpoint TS 实现卡壳，临时 spawn `ncm-cli` 命令补齐
- 不影响主线架构，只是开发期加速

### 6.3 集成 CITA 问题的处理顺序

CITA 链脆弱（第一、二章描述的 E_CONTEXT_REF_NOT_FOUND、"已播放未调工具"）和 Python 迁移是两个独立问题，但方案 C 同时解决两者：

```
方案 C 落地后：
├─ CITA candidateRef 间接层 → 直接废弃，工具接 songId 原始 ID
├─ Python + uv + pyncm → 直接废弃，TS 调 OpenAPI
├─ orpheus:// 强依赖 → 改用 mpv（可选，待 mpv 集成评估）
└─ MiniMax 文本格式 tool call → 独立问题，不在本方案范围
```

### 6.4 风险与未决清单

- [ ] **5000/天配额**：按 appId 计还是按用户计？需在拿到资质后实测确认。如果按 appId 共享，多用户场景会撞；如果按 OAuth 用户隔离，5000/天/用户宽裕
- [ ] **OpenAPI endpoint 覆盖度**：ncm-cli README 列的能力不一定覆盖 Cyrene 当前 9 个工具的全部功能，需要拉 ncm-cli 源码逐一对照（待运行 `ncm-cli --help` 和子命令清单）
- [ ] **device 字段合规**：OpenAPI 示例 device 是智能手表参数（`andrwear`/`otos`/`hm`），桌面 Electron 应用能否传 desktop/pc 类参数，需要资质下来后实测
- [ ] **mpv 依赖**：ncm-cli 播放走 mpv，用户需要装 mpv（~30MB）。是否 bundle 进 Cyrene 安装包待评估
- [ ] **ncm-cli 源码学习可行性**：MIT 许可下可读可改，需要把 bin 入口和命令实现拉出来看（ffprobe-static 静态二进制下载卡死，需要换 `--omit=optional` 或在能跑的环境上跑）
- [ ] **CITA 止血**：方案 C 落地前，第一、二章描述的 CITA 问题仍会让用户碰到 E_CONTEXT_REF_NOT_FOUND。可以选择：(a) 等 C 落地；(b) 先按第一章末尾的方案 A+D 止血（music_search 单结果直连播放 + 修 description 文案），1 天内可完成

---

## 七、下一步行动建议

按优先级：

1. **等 OpenAPI 资质下来**（你已经申请）——拿到 appId/privateKey 后能立刻开始方案 C 落地
2. **拉 ncm-cli 源码**（绕开 ffprobe 卡死）——用 `npm install @music163/ncm-cli --omit=optional` 在临时目录装，把 bin 入口和命令实现拉出来读，确认 endpoint 覆盖度
3. **拉官方 skills 源码**——[github.com/NetEase/skills](https://github.com/NetEase/skills) 的 `netease-music-cli` prompt 设计可以借鉴，作为 Cyrene tools description 的参考
4. **决定是否先做 CITA 止血**——如果 OpenAPI 资质下来还要等几天，建议先按第一章方案 A+D 止血（1 天），避免用户继续踩 E_CONTEXT_REF_NOT_FOUND
5. **MiniMax adapter 问题独立处理**——和音乐链路无关，但会偶尔让模型把 tool_call 当文本吐出来，影响所有工具调用，建议单独立项

---

> 文档状态：2026-08-17 重大更新完成，第五至七章取代前文判断作为决策依据。
> 待补：ncm-cli 源码细节、OpenAPI endpoint 覆盖度实测、device 字段合规实测、5000/天配额口径实测——等资质下来后回填。
