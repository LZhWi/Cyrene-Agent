# 新增 MiMo（小米）Provider 设计

**日期**：2026-07-14
**作者**：ZCode + 用户协作
**状态**：待 review

## 目标

让用户在 API 设置里能看到并使用 **小米 MiMo**（mimo.mi.com）作为 AI provider，
并顺手做两件基础工作：

1. 把 `transport` 与 `authStyle` 解耦，让 `ProviderCapability.authStyle` 真正生效
   （目前 OpenAI / Anthropic adapter 都硬编码了鉴权 header 名）
2. 把 8 家现有厂商的 icon URL 从 unpkg CDN 切到 npmmirror CDN（更稳定、国内可达）

## 范围

### In scope

| # | 项目 | 涉及文件 |
|---|------|---------|
| 1 | 新增 `MiMo（小米）` provider（capability + preset） | `capabilities.ts`, `settings.ts` |
| 2 | `authHeaderFor` 提取到 `vendors/auth.ts` 公共模块 | 新建 `auth.ts`, 改 `openai-adapter.ts`, `anthropic-adapter.ts` |
| 3 | 视觉模型独立配置（主模型 `mimo-v2.5-pro` 不自动作为视觉模型） | `settings.ts`, `index.html` 视觉同步按钮默认态 |
| 4 | 9 个厂商 icon URL 替换 | `settings.ts`（拆为独立 commit） |

### Out of scope（YAGNI）

- 不引入 `custom-header` 鉴权类型（当前无使用方）
- 不预设 Token Plan 国内入口（用户手填 URL 自动支持）
- 不接入 `mimo-v2.5-pro-ultraspeed`（需申请权限）
- 不接入已下线的 V2 系列
- 不改 `transport-detector.ts`（现有规则已覆盖 MiMo `/v1` 和 `/anthropic`）
- 不改 `getAdapter()` 缓存策略（旧路径 cache key 不含 transport，但是 v1 旧入口，
  新代码已迁到 `getAdapterForConfig()`，且现有 8 家厂商都是单 transport 不受影响；
  在测试里加注释说明此历史包袱）

## 设计

### 1. 鉴权抽象（解耦 transport 与 authStyle）

**现状问题**：

`OpenAICompatAdapter.buildRequest`（`openai-adapter.ts:75-78`）硬编码：

```typescript
headers: {
  "Content-Type": "application/json",
  Authorization: `Bearer ${cfg.apiKey}`,
}
```

`AnthropicAdapter.buildRequest`（`anthropic-adapter.ts:118-122`）硬编码：

```typescript
headers: {
  "Content-Type": "application/json",
  "x-api-key": cfg.apiKey,
  "anthropic-version": ANTHROPIC_VERSION,
}
```

两个 adapter 完全没读 `this.capability.authStyle`。

**改动**：新建 `src/main/orchestrator/vendors/auth.ts`：

```typescript
import type { ProviderCapability } from "./types";

/**
 * 根据 provider capability 的 authStyle 生成鉴权 header。
 * transport 与 authStyle 解耦：Anthropic transport 也可以配 bearer
 * （如 MiMo /anthropic 端点）。
 *
 * 不在日志或错误对象中输出 apiKey。
 */
export function authHeaderFor(
  cap: ProviderCapability,
  apiKey: string,
): Record<string, string> {
  switch (cap.authStyle) {
    case "x-api-key":
      return { "x-api-key": apiKey };
    case "bearer":
    default:
      return { Authorization: `Bearer ${apiKey}` };
  }
}
```

OpenAI adapter 改为：

```typescript
return {
  url: buildUrl(cfg.baseUrl),
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...authHeaderFor(this.capability, cfg.apiKey),
  },
  body: JSON.stringify(body),
};
```

Anthropic adapter 改为：

```typescript
return {
  url: buildUrl(cfg.baseUrl),
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...authHeaderFor(this.capability, cfg.apiKey),
    "anthropic-version": ANTHROPIC_VERSION,  // 与 authStyle 无关，保留
  },
  body: JSON.stringify(body),
};
```

### 2. MiMo capability 配置

`src/main/orchestrator/vendors/capabilities.ts` 新增：

```typescript
{
  id: "mimo",
  displayName: "MiMo（小米）",
  // 默认入口：用户切 /anthropic 时由 detectTransport 自动推断
  transport: "openai",
  baseUrl: "https://api.xiaomimimo.com/v1",
  // 官方文档：/v1 与 /anthropic 都支持 Authorization: Bearer
  authStyle: "bearer",
  defaultModel: "mimo-v2.5-pro",
  supportsTools: true,
  supportsThinking: true,
  thinkingField: "reasoning_content",
  cacheStrategy: "auto",
  testStrategy: "text",
  supportsVision: true,
  // 结构上独立：用户切主入口到 /anthropic 时视觉仍由 visionBaseUrl 决定
  visionBaseUrl: "https://api.xiaomimimo.com/v1",
},
```

**关键不变性**：transport 检测只决定用哪个 adapter，**不得替换 provider capability**。
当 MiMo 走 `/anthropic` 时表现：

| 字段 | 值 |
|------|---|
| provider capability | mimo |
| transport | anthropic |
| authStyle | bearer |
| actual header | `Authorization: Bearer <key>` + `anthropic-version: ...` |

这意味着 AnthropicAdapter 拿到的 `this.capability` **仍然是 MiMo 的 capability**，
`this.capability.authStyle === "bearer"`——解耦后这一表现自然达成。

### 3. MiMo preset 配置

`src/renderer/settings/settings.ts` 的 `MODEL_PRESETS` 新增：

```typescript
{
  providerName: "MiMo（小米）",
  shortName: "MiMo",
  baseUrl: "https://api.xiaomimimo.com/v1",
  mainModels: ["mimo-v2.5-pro"],
  iconUrl: PROVIDER_ICON_URLS.mimo,
  websiteUrl: "https://mimo.mi.com/",
  visionBaseUrl: "https://api.xiaomimimo.com/v1",
  // 主模型 mimo-v2.5-pro 不适合做视觉（视觉模型是 mimo-v2.5）
  independentVision: true,
  defaultVisionModel: "mimo-v2.5",
  visionModels: ["mimo-v2.5"],
  // supportsVision 不写（默认 false），因为视觉模型与主模型不同，
  //  不应触发"与主相同"的默认行为
},
```

`ModelPreset` 接口新增三个可选字段：

```typescript
/** 该厂商的视觉模型与主模型本质不同（如 MiMo 主 mimo-v2.5-pro、视觉 mimo-v2.5），
 *  强制独立配置，无法"与主聊天模型相同"。 */
independentVision?: boolean;
defaultVisionModel?: string;
visionModels?: string[];
```

### 4. 视觉模型独立（主模型不同步）

**问题**：现有 `applyVisionSyncUI()`（`settings.ts:949`）在"与主聊天模型相同"模式下，
用 `getCurrentModelValue()`（主模型）覆盖视觉模型框。
MiMo 的主模型是 `mimo-v2.5-pro`，但 MiMo 当前只支持 `mimo-v2.5` 做视觉——直接同步会跑错模型。

**改动**：在 `applyVisionSyncUI()` 顶部判断当前 preset 是否有 `defaultVisionModel`。
**约定**：MiMo 这种"主模型不适合做视觉"的厂商在 `MODEL_PRESETS` 上不写
`supportsVision: true`，而是用新字段 `independentVision: true` 标记——独立视觉模型
无法与主模型同步，因为它们本质是不同模型。

```typescript
function applyVisionSyncUI(): void {
  const synced = visionSyncMainBtn.classList.contains("is-active");
  const preset = findPreset(activeProvider);

  if (preset?.independentVision) {
    // 该厂商的主模型不适合做视觉（如 MiMo：主 mimo-v2.5-pro，视觉 mimo-v2.5）。
    // 强制独立配置：视觉框锁为独立值，胶囊按钮"独立配置"高亮。
    visionSyncMainBtn.classList.remove("is-active");
    visionSyncIndepBtn.classList.add("is-active");
    setVisionSyncState(false);  // 切到独立配置态
    visionFieldsWrap.classList.remove("is-locked");
    const visionBaseUrl = preset.visionBaseUrl || baseUrlInput.value;
    visionBaseUrlInput.value = visionBaseUrl;
    visionApiKeyInput.value = apiKeyInput.value;
    if (!visionModelInput.value) {
      visionModelInput.value = preset.defaultVisionModel ?? "";
    }
    return;
  }

  if (synced) {
    // 现有行为：完全跟随主模型
    visionFieldsWrap.classList.add("is-locked");
    const visionBaseUrl = preset?.visionBaseUrl || baseUrlInput.value;
    visionBaseUrlInput.value = visionBaseUrl;
    visionApiKeyInput.value = apiKeyInput.value;
    visionModelInput.value = getCurrentModelValue();
  } else {
    visionFieldsWrap.classList.remove("is-locked");
  }
}
```

`ModelPreset` 新增字段：

```typescript
/** 该厂商的视觉模型与主模型本质不同（如 MiMo 主 mimo-v2.5-pro、视觉 mimo-v2.5），
 *  强制独立配置，无法"与主聊天模型相同"。 */
independentVision?: boolean;
```

视觉模型输入框的 datalist 候选：

```typescript
// 在 applyPreset 末尾或合适位置：
function fillVisionModelOptions(preset: ModelPreset, preferredModel?: string): void {
  const datalist = document.getElementById("vision-model-suggestions") as HTMLDataListElement | null;
  if (!datalist) return;
  datalist.replaceChildren();
  for (const m of preset.visionModels ?? []) {
    const option = document.createElement("option");
    option.value = m;
    datalist.appendChild(option);
  }
  // 优先用 preferredModel（用户已有编辑值），否则用 preset 默认
  if (preferredModel !== undefined) {
    visionModelInput.value = preferredModel;
  } else if (preset.defaultVisionModel) {
    visionModelInput.value = preset.defaultVisionModel;
  }
}
```

> 不动 `VisionModelConfig` 类型——视觉模型字段已存在（`VisionModelConfig.model`），
> renderer 对应 `visionModelInput`，结构上与主模型完全独立。

### 5. Icon URL 全量替换

`src/renderer/settings/settings.ts` 顶部新增常量：

```typescript
const PROVIDER_ICON_URLS = {
  minimax:    "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.91.0/files/icons/minimax-color.svg",
  deepseek:   "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.91.0/files/icons/deepseek-color.svg",
  volcengine: "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.91.0/files/icons/volcengine-color.svg",
  glm:        "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.91.0/files/icons/chatglm-color.svg",
  kimi:       "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.91.0/files/icons/kimi-color.svg",
  qwen:       "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.91.0/files/icons/qwen-color.svg",
  openai:     "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.91.0/files/icons/openai.svg",
  anthropic:  "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.91.0/files/icons/claude-color.svg",
  mimo:       "https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/xiaomimimo.png",
} as const;
```

> 注：MiMo 的 icon URL **是 GitHub Raw PNG**，与其它 8 家 npmmirror SVG 不同源。
> 这是 lobehub-icons 当前仓库组织决定的（MiMo 图标在该仓库的 `static-png/light/`
> 路径下，不在 `icons-static-svg` 包里）。
> 已在 2026-07-14 抓取验证全部 9 个 URL 返回 200。

`MODEL_PRESETS` 中 9 个 `iconUrl` 字段全部改为读常量。

### 6. Transport 检测不动

`detectTransport("/v1")` 已经返回 `openai`，`detectTransport("/anthropic")` 已经返回
`anthropic`——`src/main/orchestrator/vendors/transport-detector.ts` 不动。

## 数据流

### 用户首次选 MiMo

```
1. 用户在 <select> 选 "MiMo（小米）"
2. fillPresetOptions() 找到 preset（independentVision=true, defaultVisionModel="mimo-v2.5"）
3. applyPreset(preset):
   - baseUrl = "https://api.xiaomimimo.com/v1"
   - mainModels = ["mimo-v2.5-pro"]  → fillModelOptions 填入 modelInput
   - visionBaseUrl = "https://api.xiaomimimo.com/v1"
   - visionModels = ["mimo-v2.5"]    → fillVisionModelOptions
4. applyVisionSyncUI():
   - preset.independentVision === true
   - 强制独立配置态：胶囊按钮"独立配置"高亮
   - visionFieldsWrap.classList.remove("is-locked")
   - visionBaseUrl = preset.visionBaseUrl = "https://api.xiaomimimo.com/v1"
   - visionModel = "mimo-v2.5"（因为 visionModelInput 空才填，避免覆盖用户已编辑）
5. 用户填 apiKey，保存 → saveModelSettings → normalizeModelSettings
6. perProvider["MiMo（小米）"] + vision 配置落盘
```

### 用户切到 /anthropic

```
1. 用户手动改 baseUrl = "https://api.xiaomimimo.com/anthropic"
2. resolveTransport({baseUrl, explicitTransport: "auto"}):
   - explicitTransport=auto → detectTransport("/anthropic") = "anthropic"
3. getAdapterForConfig(cfg):
   - transport = "anthropic"
   - adapter = new AnthropicAdapter("mimo", mimo_capability)
   - this.capability.authStyle === "bearer"
4. buildRequest 调 authHeaderFor(mimo_capability, apiKey):
   - 返回 { Authorization: "Bearer <key>" }
5. 最终 headers:
   - Content-Type: application/json
   - Authorization: Bearer <key>     ← 来自 MiMo capability，不是默认 x-api-key
   - anthropic-version: 2023-06-01
```

## 错误处理与日志脱敏

- `authHeaderFor` 内部不打印 apiKey
- 测试连通性失败时（`openai-adapter.ts:210`），错误信息只显示响应体前 200 字符
- adapter 不输出完整 request headers 到日志（避免 apiKey 泄露）
- `visionModelInput.value` 与 `modelInput.value` 完全独立，落盘 / 启动时互不覆盖

## 测试计划

### `src/main/orchestrator/vendors/auth.test.ts`（新建）

- `bearer` → `{ Authorization: "Bearer sk-test" }`
- `x-api-key` → `{ "x-api-key": "sk-test" }`
- 不传 `authStyle` / 未知值 → 默认 `bearer`
- 任意路径下输出对象都不包含 `apiKey` 字面量（用正则检查）

### `src/main/orchestrator/vendors/openai-adapter.test.ts`（扩展）

- `authStyle: "bearer"` → headers 含 `Authorization`
- `authStyle: "x-api-key"` → headers 含 `x-api-key`
- 现有 8 家走 `bearer` 的回归测试通过

### `src/main/orchestrator/vendors/anthropic-adapter.test.ts`（扩展）

- `authStyle: "bearer"` + `transport: "anthropic"` → headers 含 `Authorization`
  而**不是** `x-api-key`（解耦生效）
- `authStyle: "x-api-key"` → headers 含 `x-api-key`
- **关键场景**：MiMo capability（id="mimo", authStyle="bearer"）传入 AnthropicAdapter，
  buildRequest 必须产生 `Authorization: Bearer` 而非 `x-api-key`
- `anthropic-version` header 与 authStyle 无关，必须保留

### `src/main/orchestrator/vendors/capabilities.test.ts`（新建或扩展）

- MiMo 条目存在
- 字段齐全：`id, displayName, transport, baseUrl, authStyle, defaultModel, supportsVision, visionBaseUrl`
- `displayName === "MiMo（小米）"`

### `src/renderer/settings/apply-vision-sync.test.ts`（新建）

- 选 MiMo（independentVision=true）：视觉胶囊按钮强制高亮"独立配置"，视觉框填 `mimo-v2.5`
  **而非** `mimo-v2.5-pro`
- 选 MiniMax（无 independentVision 字段）：synced=true 时视觉框跟随主模型（现有行为，回归）
- 视觉框字段对用户的 preferredModel（手动填写）正确保留（不被覆盖）

### `src/main/orchestrator/vendors/parse-stream.test.ts`（扩展）

- OpenAI 流式 `reasoning_content` 字段解析（chunk.deltaThinking 命中）
- Anthropic 流式 `thinking` block 解析
- 非流式 `reasoning_content` 与 `thinking` 都进入 assistantMessage.thinking

## 文件改动清单

| 文件 | 类型 | commit |
|------|------|--------|
| `src/main/orchestrator/vendors/auth.ts` | 新建 | feat(provider) |
| `src/main/orchestrator/vendors/openai-adapter.ts` | 改（用 authHeaderFor） | feat(provider) |
| `src/main/orchestrator/vendors/anthropic-adapter.ts` | 改（用 authHeaderFor） | feat(provider) |
| `src/main/orchestrator/vendors/capabilities.ts` | 加 MiMo 条目 | feat(provider) |
| `src/renderer/settings/settings.ts` | 加 MiMo preset + 视觉独立 + visionModels 字段 | feat(provider) |
| `src/renderer/settings/index.html` | 视觉模型输入框加 datalist（`vision-model-suggestions`） | feat(provider) |
| `src/main/orchestrator/vendors/auth.test.ts` | 新建 | feat(provider) |
| `src/main/orchestrator/vendors/openai-adapter.test.ts` | 扩展 | feat(provider) |
| `src/main/orchestrator/vendors/anthropic-adapter.test.ts` | 扩展 | feat(provider) |
| `src/main/orchestrator/vendors/capabilities.test.ts` | 新建 | feat(provider) |
| `src/renderer/settings/apply-vision-sync.test.ts` | 新建 | feat(provider) |
| `src/renderer/settings/settings.ts` | icon URL 全量替换 | chore(icons) |

## 提交策略

拆为两个独立 commit：

1. `feat(provider): add Xiaomi MiMo provider`
   - 新增 MiMo + 解耦 transport/authStyle + 视觉独立 + 新测试
2. `chore(icons): migrate provider icons to npmmirror`
   - 仅替换 icon URL 常量定义与 9 处引用

两者必须可独立 revert——`chore(icons)` 回滚后 `feat(provider)` 仍能用旧 unpkg icon 工作；
`feat(provider)` 回滚后 `chore(icons)` 仍能让现有 8 家显示新 icon。

## 风险与回退

| 风险 | 缓解 |
|------|------|
| MiMo `/anthropic` 端点是否真支持 `Authorization: Bearer` | 实施时手动 curl 一次官方 `/anthropic/v1/messages` 验证；如不支持，回退方案是把 MiMo `authStyle` 临时改为 `x-api-key` |
| `applyVisionSyncUI` 改动影响 MiniMax 视觉行为 | 现有 MiniMax preset 不带 `defaultVisionModel`，新分支不进入，回归测试覆盖 |
| `getAdapter()` 旧路径 cache key 不含 transport | 历史包袱，注释说明，不在本次修 |
| npmmirror CDN 失效 | 9 个 URL 已 2026-07-14 验证 200；如失效回退到原 unpkg URL（不丢数据，只丢外观） |
| MiMo 文档后续变化 | capability 在 `capabilities.ts` 集中，修改只动一处 |

## 验证步骤

1. `npm run build` 通过
2. `npm run test` 所有测试通过（含新增）
3. `npm run dev` 启动，settings 窗口能看到 "MiMo（小米）" 选项
4. 选 MiMo 填假 key：
   - OpenAI 入口：测试连通性应返回 401（key 无效）而不是网络错误
   - 切到 `/anthropic`：测试连通性应同样 401，且 wire 上 Authorization 不是 x-api-key
5. 视觉框默认填 `mimo-v2.5` 而非 `mimo-v2.5-pro`
6. 切回其他厂商（如 MiniMax），视觉同步行为不变（回归）