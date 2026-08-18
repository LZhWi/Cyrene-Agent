# 网易云音乐 OpenAPI 实测验证（M0）

> 状态：**已完成**。协议 + 12 个 endpoint 全部实测通过。
> 验证方式：webcrack 反混淆 `@music163/ncm-cli@0.1.6` + 真实 key PoC 实测（2026-08-18）。

---

## 零、M0 结论速览

| 验证项 | 结果 |
|---|---|
| 签名算法复刻 | ✅ 与官方一致 |
| 匿名登录 | ✅ 24h token（但调不动业务接口） |
| QR 扫码登录 | ✅ 实扫 803，用户 token 24h |
| manifest | ✅ POST 拿到 72 个 endpoint 完整契约 |
| 搜索 | ✅（**必须带 trialScene:"cli"**） |
| 歌曲播放 URL | ✅ **mpv 路径实证可行**（HEAD 200 audio/mpeg 2.9MB） |
| 歌词 | ✅ LRC + 纯文本 + 翻译 + 音译四格式 |
| 每日推荐 | ✅ data 直接是数组 |
| 我的歌单/详情/曲目 | ✅ |
| 红心歌单 / 收藏接口 | ✅ 存在（like/v2） |
| 用户 profile | ✅ |
| 封面防盗链 | ✅ **无防盗链**，renderer 直连即可，cover-proxy 不需要 |
| 写操作（创建/加歌/收藏） | ⏸ manifest 有完整契约，未实测写（避免污染用户数据），M1 集成时验证 |

---

## 一、HTTP 协议

**Base URL**：`http://openapi.music.163.com`

### 1.1 公共参数（每个请求都带）

| 参数 | 值 | 说明 |
|---|---|---|
| `appId` | 平台分配 | |
| `signType` | `RSA_SHA256` | 固定 |
| `timestamp` | `String(Date.now())` | 毫秒 |
| `device` | JSON 字符串 | 服务端强校验，见 1.2 |
| `bizContent` | JSON 字符串 | 业务参数 |
| `accessToken` | 可选 | 匿名/用户 token |
| `sign` | base64 | 见 1.3 |

### 1.2 device 参数（实测通过的值）

```json
{
  "deviceType": "openapi",
  "os": "ncmcli",
  "appVer": "0.1.6",
  "channel": "ncmcli",
  "model": "Windows_x64_cli",
  "brand": "ncmcli",
  "osVer": "10.0.19045",
  "clientIp": "127.0.0.1",
  "deviceId": "cyrene-poc-001"
}
```

坑：`deviceType` 必须 `openapi`；`os/channel/brand` 必须 `ncmcli`；`model` = `{Platform}_{arch}_cli`。填错报 400「公共参数校验失败」。

### 1.3 签名算法（实测通过）

```js
function buildSignString(params) {
  return Object.entries(params)
    .filter(([k, v]) => k !== 'sign' && v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [k, String(v)])
    .sort(([a], [b]) => a.localeCompare(b))   // 字典序
    .map(([k, v]) => k + '=' + v).join('&');
}
// RSA-SHA256 + pkcs8 PEM → base64
const s = crypto.createSign('SHA256');
s.update(buildSignString(params)); s.end();
params.sign = s.sign(PRIVATE_KEY_PEM, 'base64');
```

平台 privateKey 是裸 base64，包 PEM：
`'-----BEGIN PRIVATE KEY-----\n' + b64.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----'`

### 1.4 请求格式

- GET：全参数（含 sign）进 query（URLSearchParams），header `User-Agent: ncm-0.1.6` + `Referer: https://music.163.com/`
- POST：全参数（含 sign）作 JSON body，`Content-Type: application/json`

### 1.5 错误码

| code | 含义 |
|---|---|
| 200 | 成功 |
| 400 | 参数错误（**空 body 时通常是缺 manifest 里的 hidden 默认参数**，如 trialScene） |
| 301 | 用户未授权当前接口（匿名 token 调用户级接口） |
| 1406 | 版权限制无法播放 |
| -444/-446/-447/-461 | 播放权限相关（源码） |

---

## 二、登录体系（全部实测通过）

### 2.1 匿名登录

```
POST /openapi/music/basic/oauth2/login/anonymous
bizContent: { "clientId": "<appId>" }
→ data: { accessToken, refreshToken, expireTime: 86400 }
```

**匿名 token 调业务接口全部 301**，仅能走 QR 流程。

### 2.2 QR 登录（用户 token 唯一途径）

```
1) GET /openapi/music/basic/user/oauth2/qrcodekey/get/v2
   bizContent: { "type": 2, "expiredKey": "300" }
   → data: { qrCodeUrl: "https://163cn.tv/xxx", uniKey: "<uuid>" }

2) GET /openapi/music/basic/oauth2/device/login/qrcode/get   （3s 轮询）
   bizContent: { "key": "<uniKey>", "clientId": "<appId>" }
   → data.status: 801 等待扫码 | 802 待确认 | 803 成功 | 800 过期
   803 时 data.accessToken: { accessToken, refreshToken, expireTime: 86400 }
```

实测：801 → 扫码 → 803 全链路通，token 24h。

### 2.3 Token 刷新（源码确认，未实测）

```
/openapi/music/basic/user/oauth2/token/refresh/v2
```
策略：用户 token 优先 → 过期 refresh（13 天窗口）→ 匿名兜底。

---

## 三、业务 Endpoint（全部实测通过 ✅）

### 3.1 搜索（`search.song`）

```
GET /openapi/music/basic/search/song/get/v3
bizContent: { keyword, limit: 30, offset: 0, qualityFlag: false, trialScene: "cli" }
→ data: { recordCount, records: [{
    originalId: 3339230677,                          // 数字 ID
    id: "4C777A98B81DF0CC069B59F63F3882B1",         // 加密 ID（32-hex）
    name, duration: 182890,
    jumpUrl: "orpheus://song/3339230677",
    artists: [{ originalId, id, name, coverImgUrl }],
    fullArtists: [...]
  }] }
```

**大坑：`trialScene:"cli"` 必须传**，否则 400 空 body。所有带 hidden 默认参数的接口同理——**实现时一律传 manifest 全部默认值**。

其他搜索：`/complex/search`（综合：歌曲+歌单+专辑+艺人）✅、`/search/album/get/v2`、`/search/playlist/get/v2`、`/search/mv/get/v1`。

### 3.2 歌曲详情 + 播放 URL（mpv 核心，✅ 实证可行）

```
GET /openapi/music/basic/song/detail/get/v2
bizContent: { songId: "<加密ID>", withUrl: true, bitrate: 128, trialScene: "cli" }
→ data: { name, artistName, albumName,
    playUrl: "http://iot202.music.126.net/...",     // 真实音频 URL
    coverImgUrl, duration, br: 128000, level, freeTrail, freeTrialPrivilege }
```

**playUrl 实测：HEAD 200 `audio/mpeg` 2927277 字节，可直接喂 mpv。**
**songId 必须传加密 ID（32-hex）**，传数字 ID 报「参数错误」。

### 3.3 歌词（✅）

```
GET /openapi/music/basic/song/lyric/get/v2
bizContent: { songId: "<加密ID>" }
→ data: { originalId, id, songId,
    lyric,        // LRC 带时间轴（部分歌曲为空）
    txtLyric,     // 纯文本歌词（实测有内容）
    transLyric,   // 翻译
    romalrc,      // 音译
    noLyric, pureMusic }
```

UI 契约 `{timeMs, text}[]`：优先解析 `lyric`（LRC），空则降级 `txtLyric`（无时间轴，整段展示）。

### 3.4 每日推荐（✅）

```
GET /openapi/music/basic/recommend/songlist/get/v2
bizContent: { limit: 30, qualityFlag: false, trialScene: "cli" }
→ data: 直接是 records 数组（无 wrapper）
```
推荐的是歌曲列表（song 对象，含双 ID + artists + duration）。

### 3.5 我的创建歌单（✅）

```
GET /openapi/music/basic/playlist/created/get/v2
bizContent: { limit: 20, offset: 0 }
→ data: { recordCount, records: [{ id(加密), originalId, name, trackCount, ... }] }
```

### 3.6 收藏的歌单（subed/get/v2）、红心歌单（star/get/v2 ✅）

```
GET /openapi/music/basic/playlist/star/get/v2   bizContent: {}
→ data: { originalId, id, name: "xxx喜欢的音乐", jumpUrl, coverImgUrl, playCount, ... }
```

### 3.7 歌单详情 + 曲目（✅）

```
GET /openapi/music/basic/playlist/detail/get/v2
bizContent: { playlistId: "<加密ID>", originalCoverFlag: false }
→ data: { originalId, id, name, coverImgUrl, describe, creatorNickName, ... }

GET /openapi/music/basic/playlist/song/list/get/v3
bizContent: { playlistId: "<加密ID>", limit: 30, offset: 0, qualityFlag: false, trialScene: "tui" }   // 注意 tui 不是 cli
→ data: 直接是歌曲数组
```

### 3.8 写操作（manifest 契约确认，未实测写）

| 操作 | 方法 | Endpoint | bizContent |
|---|---|---|---|
| 创建歌单 | GET | `/playlist/create` | `{ playlistName }` |
| 加歌进歌单 | POST | `/playlist/song/batch/like` | `{ playlistId, songIdList: [加密ID] }` |
| 移出歌单 | POST | `/playlist/song/batch/delete` | `{ playlistId, songIdList }` |
| 红心收藏 | POST | `/playlist/song/like/v2` | `{ songId }` |
| 改歌单名 | POST | `/playlist/name/update` | `{ playlistId, name }` |
| 改歌单描述 | POST | `/playlist/desc/update` | `{ playlistId, desc }` |
| 心动模式 | POST | `/song/play/intelligence/get` | `{ playlistId, songId, type:"fromPlayAll", count:20 }` |
| 私人FM | POST | `/private/fm/roaming/song/list` | `{ type, code, limit:3 }` |

### 3.9 用户信息（✅）

```
GET /openapi/music/basic/user/profile/get/v2  → data: { nickname, userId, avatarUrl }
```

### 3.10 封面图（✅ 无防盗链）

`p1.music.126.net` 封面直连（无 Referer）200 image/jpg。**renderer `<img>` 直连即可，cover-proxy.ts 不需要**。

---

## 四、manifest（endpoint 发现机制）

```
POST /openapi/v1/ncm/cli/manifest
bizContent: { cliVersion: "0.0.0", cachedVersion: "{}" }
→ { notices: [], manifests: { search: {version, methods:[{name, description, path, parameters, http_method, auth_required, fixed_params}]}, playlist: {...}, song: {...}, ... } }
```

12 个资源组、72 个 endpoint。**完整契约已存 `tmp-m0-poc/manifest-full.json`**。参数含 name/type/required/default/hidden——hidden 参数也有默认值且**服务端要求传**。

---

## 五、对重构计划的直接影响

| 计划项 | 影响 |
|---|---|
| 风险 1（扫码必须） | ✅ 确认，匿名 token 无业务能力 |
| 风险 4（device 参数） | ✅ 解除，官方值照抄 |
| 风险 6（mpv 可行性） | ✅ **解除**，playUrl 实测可用 |
| 风险 7（歌词） | ✅ 有 endpoint，双格式（LRC + txt） |
| 风险 8（封面防盗链） | ✅ **解除**，无防盗链，删 cover-proxy.ts |
| 风险 9（收藏） | ✅ 有 `playlist/song/like/v2`，isFavorite 可做（红心歌单查询初始态） |
| `music_play_track` 入参 | 加密 ID（32-hex），搜索/推荐/歌单结果全带 |
| TokenVault | 存 accessToken + refreshToken（24h + 13 天 refresh 窗口） |
| trialScene 传参规则 | client 封装时把 manifest 默认参数硬编码进每个方法 |

## 六、PoC 资产（tmp-m0-poc/，M5 时删除）

- `poc.mjs` / `phase2.mjs` / `phase3.mjs` / `phase4.mjs` / `probe-search.mjs`：协议复刻 + 全 endpoint 实测
- `qr-login.mjs`：QR 登录全流程（终端二维码 + 轮询 + token 存盘）
- `user-token.json`：当前用户 token（24h 过期）
- `manifest-full.json`：72 endpoint 完整契约（**client 实现的圣经**）
- `phase4-result.json`：各 endpoint 真实响应样本
