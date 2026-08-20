# API 模型档案化改造施工文档

> 目标：设置页 API 区域从「单厂商表单」改造为「档案编辑器」——建档、测试在设置页，切换、使用在 chat 窗口。
> 每套档案自带：昵称、API Key、Base URL、协议、模型名、上下文窗口、是否多模态。

---

## 现状与问题

### 现状

- **chat 窗口侧已就绪**：`ModelModePanel.tsx` 已有档案卡片列表（搜索/设默认/删除），IPC（`SETTINGS_MODEL_PROFILES_*`）已接通，会话绑定档案（`CHATS_SET_MODEL_PROFILE`）已有。
- **设置页侧是旧交互**：选厂商预设 → 填一张表 → 保存时顺手把当前配置塞进档案列表（`settings.ts:1336-1380` 的 `apiForm` submit）。
- **数据层是拼接产物**：
  - 老一代：`perProvider: Record<string, ProviderProfile>`（每厂商一套，切换缓存，`providerProfileCache`）。
  - 新一代：`modelProfiles: SavedModelProfile[]`（多档案，含 id/昵称），但 UI 只能被动生成 + 删除，**没有编辑**。

### 问题

| # | 问题 | 根因 |
|---|------|------|
| 1 | 同一厂商建不了两套配置（官方 API + 中转站互相覆盖） | perProvider 按厂商名做 key，一厂一套 |
| 2 | 档案填错只能删了重建 | `saveModelProfile` 只支持新增，无更新 |
| 3 | 上下文窗口是全局单值，切模型不跟随 | `contextWindowTokens` 在顶层 `ModelSettings`，不在档案里 |
| 4 | 多模态是全局单值，切到不支持图片的模型仍按 direct 发图 | `multimodal` 在顶层，`CHAT_GET_IMAGE_SEND_STRATEGY` 读全局 |
| 5 | 去重过严：同 Key + 同模型名想建两份（不同上下文/不同用途）被拒 | `sameModelCredential` 只比对 apiKey + model |

---

## 设计

### 核心思路

```
┌─ 设置页（API）───────────────────┐      ┌─ Chat 窗口（已有）─────────┐
│ 档案列表：  [＋ 新建档案]          │      │ ModelModePanel 档案卡片    │
│  ● GLM官方  glm-4.7  128k ✓图    │      │ 搜索 / 设默认 / 删除       │
│  ● GLM中转  glm-4.7  200k       │      │ 新对话用默认档案           │
│  ● DeepSeek v3       64k        │      │ 当前对话绑定档案           │
│ 点击档案 → 编辑表单：              │      └───────────────────────────┘
│  昵称/Key/URL/协议/模型名/        │
│  上下文/多模态 [测试连接][保存][删]│
│ ── 全局选项（不随档案走）──        │
│  独立视觉模型/思考开关/MaxToken   │
└──────────────────────────────────┘
```

- 设置页只管「建档 + 测试」，chat 窗口只管「用哪个」。
- 厂商预设降级为「新建档案的起点」（预填 URL/模型名/协议），不再是配置主体。

### 数据结构改动

`ProviderProfile`（`src/main/settings/model-settings.ts:32`）增加两个可选字段，`SavedModelProfile` 继承自动获得：

```ts
export interface ProviderProfile {
  // ...现有字段 baseUrl/model/apiKey/displayName/explicitTransport/reasoning
  /** 上下文窗口（Token）。未定义 = 回退全局 ModelSettings.contextWindowTokens。 */
  contextWindowTokens?: number;
  /** 主模型是否多模态。未定义 = 回退全局 ModelSettings.multimodal。 */
  multimodal?: boolean;
}
```

**关键字段为可选 + 回退全局**的理由：
- 老档案（迁移前已存在的）没有这两个字段，回退全局 = 现行为，零回归。
- 顶层 `contextWindowTokens` / `multimodal` 保留，作为「未编辑档案的默认值」，消费侧类型不变。

### 档案解析（会话生效的核心）

`resolveModelSettingsProfile`（`model-settings.ts:327`）在展开档案到顶层镜像时，一并覆盖新字段：

```ts
return {
  ...settings,
  // ...现有字段展开
  contextWindowTokens: profile.contextWindowTokens ?? settings.contextWindowTokens,
  multimodal: profile.multimodal ?? settings.multimodal,
};
```

**这一处改动让上下文窗口自动按会话生效**：`agent-runtime.ts:137` 已经按 `modelProfileId` 解析 settings，`context-manager.ts:92`、`build-options.ts:750` 读的都是解析后的 `settings.contextWindowTokens`，全部零改动跟着走。

### 保存 API 改造

`saveModelProfile`（`model-settings.ts:342`）支持两种模式：

- **带 id 且档案存在 → 更新**：按 id 定位，字段全量覆盖（表单即全量），不走去重。
- **无 id → 新增**：去重规则从「apiKey + model 相同即拒」放宽为「apiKey + model + baseUrl 三者全同才拒」——同 Key 同模型但不同中转站、或刻意建两份不同上下文的配置都是合法需求。

`sameModelCredential`（`model-catalog.ts:8`）同步改签名比对三个字段。

### 迁移（老配置无感升级）

`normalizeModelSettings`（`model-settings.ts:267`）现有逻辑只在 `modelProfiles` 为空时造一个 legacy 档案。改为幂等补全：

- 遍历 `perProvider` 中每个 `apiKey` 与 `model` 非空的厂商；
- 若 `modelProfiles` 中不存在相同凭据（apiKey + model + baseUrl）的档案，则创建一个；
- id 用人类可读格式：`profile-<厂商名>-<序号>`（如 `profile-GLM（智谱）-1`），不用 hash/时间戳；
- 新字段不强制回填：迁移档案不写 `contextWindowTokens`/`multimodal`，运行时回退全局值 = 现行为；用户首次编辑保存后才落档案级值。

### 多模态按会话生效（发图策略）

现状 `CHAT_GET_IMAGE_SEND_STRATEGY`（`chat-ui-ipc.ts:158`）读全局。改为：

- handler 增加可选 `sessionId` 参数：`sessionId → chatsStore 查会话 → modelProfileId → resolveModelSettingsProfile → multimodal`；
- preload `getImageSendStrategy(sessionId?)`（`preload/index.ts:73`）；
- `ChatPage.tsx:1805` 调用时传当前 sessionId；
- 无 sessionId / 会话未绑档案 / 档案未定义 multimodal → 回退全局（现行为）。

**范围控制**：`loadVisionConfig()`（read_image 工具、独立视觉模型 caption 路径）本次保持全局，列为后续工作。direct/caption 的裁决只看 `multimodal` 一个布尔，本次改造后按会话正确；caption 路径用的独立视觉模型本身就是全局配置，语义不冲突。

### 设置页 UI 改造

**档案列表 + 编辑器**（替换现有 provider 预设按钮区 + 单表单）：

- 档案卡片：厂商图标 + 昵称（+ 默认徽标）+ 模型名 + 上下文徽标（如 `128k`）+ 多模态徽标（如 `✓图`）；点击载入编辑表单。
- 「＋ 新建档案」：弹出厂商预设选择（含「自定义端点」），选中后预填 baseUrl/model/协议/shortName 昵称默认值 → 进入空白编辑表单。
- 编辑表单字段：昵称、API Key、Base URL、API 协议、模型名（带 datalist 建议，按档案 provider 预填）、上下文窗口（Token，下限 4096）、多模态开关。
- 表单按钮：**测试连接**（复用现有 `testConnection` IPC，`settings.ts:1180` 已接真实 adapter）、**保存档案**（新增或更新）、**删除档案**。

**全局选项区**（不随档案走，保留在 API 页底部）：

- 独立视觉模型（vision 三件套）、思考开关（thinkingOverride）、disableMaxToken。保存走现有 `saveConfig`。

**退役代码**：

- `providerProfileCache`、`captureActiveProviderProfile`、切厂商缓存恢复逻辑（`settings.ts:618-629` 等）——表单不再绑定「当前厂商」，直接绑定档案。
- `perProvider` 在 main 侧保留（迁移数据源 + 兼容），渲染层不再读写。

### 保留不动

- chat 窗口 `ModelModePanel` 核心交互（仅可选加上下文/多模态徽标展示）。
- 自定义端点引导、模型名 datalist、`MODEL_CONFIG_CHANGED` 广播机制。
- thinkingOverride / disableMaxToken / vision 不进档案（后续工作，本次不做）。

---

## 执行步骤

### 阶段一：数据层（main 进程）

1. `model-catalog.ts`：
   - `sameModelCredential` 比对改为 apiKey + model + baseUrl 三字段。
   - 新增 `updateModelProfile(profiles, profile)`：按 id 替换，找不到返回 null。
2. `model-settings.ts`：
   - `ProviderProfile` 加 `contextWindowTokens?: number`、`multimodal?: boolean`。
   - `normalizeProviderProfile` 清洗：`contextWindowTokens` 非正整数 → undefined（下限 4096，向上不限）；`multimodal` 非 true → undefined。
   - `resolveModelSettingsProfile` 覆盖镜像（见上文代码）。
   - `saveModelProfile`：带 id 且存在 → 更新路径；否则新增 + 放宽去重。
   - 迁移补全：`normalizeModelSettings` 内对 `perProvider` 幂等建档（见上文规则）。
3. 测试：扩展 `model-catalog.test.ts`（更新/新去重规则）；新增迁移用例（perProvider 多厂商 → 档案补全、幂等、id 可读、空凭据跳过）；`resolveModelSettingsProfile` 覆盖/回退用例。

**验证**：`npx vitest run src/main/settings` 全绿；`npx tsc --noEmit -p tsconfig.main.json`。

### 阶段二：IPC 与消费

4. `settings-ipc.ts`：`SETTINGS_MODEL_PROFILE_SAVE` handler 透传 id（`saveModelProfile` 已支持，仅确认 payload 类型）；`shared/types.ts` 与 `preload` 的 `saveModelProfile` 参数类型补 `id?/contextWindowTokens?/multimodal?`。
5. `chat-ui-ipc.ts`：`CHAT_GET_IMAGE_SEND_STRATEGY` 接收可选 `sessionId`，按会话档案解析 multimodal（查会话用现有 chats-store 能力，与 `chats-ipc.ts` 同款调用）。
6. `preload/index.ts`：`getImageSendStrategy(sessionId?)`。
7. `ChatPage.tsx:1805`：调用传当前 sessionId。
8. 测试：图片策略按会话解析的用例（有档案 true / 无档案回退全局 / 无 sessionId 回退）。

**验证**：`npx vitest run src/main/chats` + tsc；手动 `npm run dev` 确认发图路径不回归。

### 阶段三：设置页 UI

9. `index.html` API 面板结构改造：档案列表区 + 编辑表单 + 全局选项区（保留原字段控件与 id，减少 CSS/JS 改动面）。
10. `settings.ts`：
    - 加载：`listModelProfiles()` 灌档案列表；默认档案徽标。
    - 编辑：点击档案 → 表单回填（新字段一并回填，未定义用全局值显示）。
    - 新建：预设选择 → 预填 → 保存时 `saveModelProfile`（无 id）。
    - 保存：`saveModelProfile`（带 id 走更新）；全局选项区单独走 `saveConfig`。
    - 删除：复用 `deleteModelProfile`。
    - 退役：`providerProfileCache` / `captureActiveProviderProfile` / 切厂商恢复逻辑 / apiForm 旧 submit 分支。
11. `settings.css`：档案卡片、徽标、列表布局样式（对齐现有 plugin-card 视觉风格）。
12. 检查 `custom-endpoint-markup.test.ts` 等对 settings.ts / index.html 的源码字符串断言，同步更新。

**验证**：`npm run build`；手测——建两个同厂商档案（不同 Key/URL）、编辑回填、测试连接、删除、重启后档案还在。

### 阶段四：回归与收尾

13. 全量验证：`npx tsc --noEmit -p tsconfig.main.json`、`npx tsc --noEmit -p tsconfig.preload.json`、`npm run build`、`npx vitest run`。
14. 手测迁移：用旧版配置文件（有 perProvider 无 modelProfiles）启动 → chat 模型面板自动出现各厂商档案。
15. 手测会话生效：建一个 8192 上下文的档案 → chat 会话绑定 → 长对话历史按 8k 截断（日志验证）；multimodal 开/关档案 → 发图走 direct/caption。

---

## 验收标准

- [ ] 同一厂商可建两套档案（官方 API + 中转站），昵称区分，互不覆盖。
- [ ] 档案可编辑：改昵称/Key/URL/上下文/多模态，保存后生效，重启不丢。
- [ ] 会话绑定档案后，上下文窗口按档案值截断历史（非全局值）。
- [ ] 会话绑定 multimodal=true 档案 → 发图 direct；false → caption；未绑定 → 回退全局。
- [ ] 老配置（perProvider 时代）首次启动自动补全档案，chat 面板可见，行为无回归。
- [ ] 设置页不再有「切厂商丢配置」问题；测试连接在编辑表单内可用。
- [ ] tsc（main/preload）、vite build、vitest 全量通过。

---

## 风险与对策

| 风险 | 对策 |
|------|------|
| `setDefaultModelProfile` 会把档案字段展开到顶层（`model-settings.ts:355`） | 加新字段后，设默认档案 = 全局默认跟随该档案，语义合理，文档化接受；normalize 清洗兜底非法值 |
| `custom-endpoint-markup.test.ts` 源码字符串断言被 UI 改动破坏 | 阶段三明确步骤 12 同步更新，先跑后改 |
| 迁移幂等性：反复启动不能重复建档 | 去重键（apiKey+model+baseUrl）在补全前先查；测试用例覆盖「normalize 两次结果一致」 |
| 档案删除后 `defaultModelProfileId` 悬空 | 现有 delete handler 已处理（回退第一个），新增用例覆盖 |
| read_image 工具仍读全局 multimodal | 明确列为后续工作，不在本次验收范围 |

---

## 后续工作（本次不做）

- thinkingOverride / disableMaxToken 档案化。
- `loadVisionConfig()` / read_image 工具按会话档案解析。
- ModelModePanel 卡片显示上下文/多模态徽标（可选增强，改动小可顺手做）。
