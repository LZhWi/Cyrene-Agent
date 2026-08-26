# run_shell 挂死 655 分钟 / GLM-5.3 思考规则失配 已知问题（2026-08-27 调研）

> 范围：`orchestrator/built-in-tools.ts`（run_shell 执行器）、`shared/reasoning.ts`（模型能力规则表）。
> 问题 1 有打包版实锤证据（进程列表 + run session 事件流）；问题 2/3 以智谱官方文档为准。

## 修复状态

| 问题 | 状态 | 修复位置 |
| --- | --- | --- |
| 1 run_shell 前台启动永驻进程导致挂死（655 分钟） | 已修复（P0+P1） | [built-in-tools.ts](../../src/main/orchestrator/built-in-tools.ts)：双计时器 + 强制 resolve + 取消杀进程树 |
| 2 GLM-5.3 规则表 `supportsDisable: true` 与官方文档矛盾 | 已修复 | [reasoning.ts](../../src/shared/reasoning.ts)：拆分 5.2/5.3 规则，5.3 `supportsDisable: false` |
| 3 auto 档思考爆炸（GLM-5.3 上 auto ≡ max 语义陷阱）；`supportedEfforts` 缺 low 档 | 已修复（A+B） | [reasoning.ts](../../src/shared/reasoning.ts)：`autoEffort: "high"` + 补 low 档；[tool_usage.md](../../prompts/tool_usage.md)：循环意识提示 |
| 4 飞书/微信消息看得到不回复——channel bot 不展开默认模型档案，顶层空配置直接 throw | 已修复（B+C） | [model-settings.ts](../../src/main/settings/model-settings.ts)：无 id 时展开默认档案；[dispatcher.ts](../../src/main/channels/dispatcher.ts)：失败落盘 log.jsonl |
| 5 欢迎语界面思考强度点开无反应——GET/SET 走顶层空壳镜像，按钮被禁用 | 已修复 | [chat-ui-ipc.ts](../../src/main/chats/chat-ui-ipc.ts)：档案解析 会话 > 欢迎页待定 > 默认档案，GET/SET 对称；[ReasoningControl.tsx](../../src/renderer/react/features/chat/components/ReasoningControl.tsx)：透传待定档案 id |
| 6 Kimi K3 缺失 reasoning 适配——K3 已是强制思考 + reasoning_effort 模型，规则表无条目 | 已补 | [reasoning.ts](../../src/shared/reasoning.ts)：`kimi-k3` → effort 控制 + openai-effort 风格 + low/high/max + `autoEffort: high`（同 GLM-5.3 体质，防 auto ≡ max 爆炸） |

验证：`tsc -p tsconfig.main.json --noEmit` 通过；vitest 全量 317 文件 / 2544 用例通过。

---

## 决策记录（2026-08-27，用户拍板"都要治本"）

1. **问题 3**：A（规则层 auto 映射 `autoEffort`）+ B（prompt 循环意识）组合落地；
   C（轮级 effort）暂不做，留待后续需要时单独评审。
2. **问题 1**：P0（双计时器 + 强制 resolve）+ P1（取消杀进程树）落地；
   P2（background 参数）未做——超时兜底已消除挂死，后台模式等真实需求再议。
3. **glm-5.3 defaultEffort**：定 `high`（用户实测 high 无爆炸），`supportedEfforts: ["low","high","max"]`，
   `autoEffort: "high"`（auto 显式映射 high，杜绝 auto ≡ max）。
4. **问题 4**：选 B（治本）——`resolveModelSettingsProfile` 无 id 时回退展开**默认档案**，
   所有不传 id 的调用方（channel bot、scheduler 等）一并修好；
   C（dispatcher 失败写 `log.jsonl`，`dir:"error"`）顺带落地，打包版排查不再靠猜。
   另：5.3 关闭思考的请求不再报错——`supportsDisable: false` 的模型 off 折叠为 on（见
   [vendors/reasoning.ts](../../src/main/orchestrator/vendors/reasoning.ts)）。

---

## 问题 4（严重）：飞书/微信消息可见但不回复——channel bot 拿到空模型配置直接抛错

**现象**：打包版（1.1.5）里，飞书/微信发来的消息能在应用内看到（桌面镜像正常），
但 Cyrene 从不回复；两端（飞书 + 微信）同时失灵。

**证据链**（`%APPDATA%\live2d-cyrene`，2026-08-27 凌晨实录）：

1. `channels/log.jsonl`：6 条 `incoming`（wechat×5 + feishu×1，03:44–03:45），**0 条 `outgoing`**。
2. `channels/history/*.jsonl`：只有 `user` 行，无 `assistant` 行——dispatcher 走到了
   入站广播/日志/历史（[dispatcher.ts](../../src/main/channels/dispatcher.ts) L246–283），
   但 `buildAndRunAgent`（L301）之后全无产出。
3. `token-usage.json` 最后写入 02:58:40（最后一次成功 LLM 调用），之后无任何 LLM 痕迹。

**根因**：channel bot 的模型解析路径与桌面聊天不一致。

- 桌面聊天：renderer 在 AGUI RunInput 里带 `modelProfileId`（用户在 UI 选的档案）
  → `resolveModelSettingsProfile(settings, id)` 展开档案 → 配置完整 → 正常。
- Channel bot（[bootstrap.ts](../../src/main/channels/bootstrap.ts) L89 的 `buildOptions` 调用）
  **不传 `modelProfileId`** → `resolveModelSettingsProfile(settings, undefined)` 返回原 settings
  （顶层镜像 = 当前 provider 的 perProvider 项）。
- 用户当前配置状态（`model-settings.json`）：顶层 provider = "MiniMax（稀宇科技）" 且
  `perProvider.MiniMax` 三件套全空；真实可用配置在 GLM 档案（默认档案）里。
  → channel bot 拿到 `baseUrl=""` → [build-options.ts L437](../../src/main/orchestrator/build-options.ts)
  `throw "还没有填写 API URL"` → dispatcher catch（L304）→ `console.error` + **return null** → 静默不回复。
- 打包版看不到主进程 console，错误被完全吞掉——表现为"看得到消息，就是不回"。

**为什么"看得到"**：incoming 镜像广播（`mirrorToDesktop`）发生在 agent 调用**之前**，
所以应用内显示一切正常；失败点在其后的模型配置校验。

**连带问题**：bootstrap.ts L63 的 `loadModelSettings()` 同样拿顶层镜像
（`multimodal=false`、vision 为 MiniMax 项），即使主修复后图片策略/视觉配置也应基于解析后的档案。

**修复方向**：

- **A. 最小修复（channel 路径）**：bootstrap.ts 构造 buildOptions input 时带上
  `modelProfileId: getDefaultModelProfile(loadModelSettings())?.id`；
  L63 的 `channelModelSettings` 同样用 `resolveModelSettingsProfile(settings, 默认档案id)`。
- **B. 治本（语义变更，需评审）**：`resolveModelSettingsProfile` 在 `id === undefined` 时
  回退展开**默认档案**而非原样返回——所有"不传 id"的调用方（scheduler 等）一并修好，
  但改变现有语义，需排查全部调用点。
- **C. 顺带**：dispatcher 的 `agent 调用失败` 分支目前只 console.error，
  建议把错误写进 `channels/log.jsonl`（`dir:"error"`），打包版排查不再靠猜。

**快速验证法**（不重启应用）：设置里把当前 provider 的顶层配置填上（或切到 GLM 档案同款配置保存），
再从手机发条消息——若恢复回复，即证实本结论。

---

## 问题 1（严重）：run_shell 挂死 655 分钟，且取消后进程残留

**现象**：打包版（Cyrene 1.1.5）执行 fpsgame 任务时，一次 run_shell 调用挂住 655 分钟不返回；用户取消 run 后，底层进程树仍残留。

**证据链**（2026-08-27 凌晨实录）：

1. 模型在前台执行 `npx serve . -l 3456`（静态文件服务器，永不退出）。
2. run session 事件流：`run-1787730142910-visdml` 中 `call_b398261a...` 于 23:12 `tool_started`，
   直到次日 01:58 用户发消息才出现 `tool_not_executed` + `run_cancelled` —— 中间挂了约 161 分钟；
   上一次同类挂死累计 655 分钟。
3. 进程列表（取消后仍存活）：PID 8980 (cmd /c npx serve) → 31332 (npx) → 43360 (cmd) → 3168 (node serve)，
   创建于 01:59:36，run 已取消但进程树未回收。

**根因分析**：

- **命令选择**：永驻进程（serve / http.server / watch / tail -f）不该前台跑。`stdio: ["ignore","pipe","pipe"]`
  已解决"等 stdin"，但没解决"进程本身不退出"。
- **超时器失效**：`built-in-tools.ts:158` 有 `SHELL_TIMEOUT_MS = 5 分钟`，300 行的 `timeoutTimer` 触发后
  调 `killTree(child)`，但 **Promise 依赖 `child.on("close")` 才 resolve**。Node 的 `close` 事件要求
  stdio 管道全部关闭；taskkill /T 若漏杀孙进程（进程链断开时会发生），管道保持打开，
  `close` 永远不触发 → 挂 655 分钟。超时"杀"了但没"收尸"。
- **取消不杀进程**：run cancel 只是不再等待结果，`runShellOnce` 的 Promise 与子进程无人终止 → 孤儿进程。

**修复方向**（对齐成熟 coding agent 的通行做法）：

1. **双计时器替代单一超时**（P0）：
   - idle 计时器：2 分钟无任何 stdout/stderr 输出 → 判定卡死（serve 类静默进程、网络死锁都会命中）；
     每收到一个 chunk 就重置。npm install / git push / 打包这类"长但在动"的命令不会误杀。
   - 总上限：30 分钟兜底，无论如何结束。
2. **超时后强制 resolve**（P0，几行代码）：killTree → 2 秒 grace period → 无条件 resolve
   （带已收集的部分输出，标记 `timedOut: true`）。杜绝 close 事件不触发导致的永久挂起。
3. **取消时杀进程树**（P1）：run cancel 链路通知执行中的 runShellOnce，killTree 该 run 的所有子进程。
4. **run_shell 增加 `background` 参数**（P2，治本）：显式后台模式（detached spawn + 立即返回 shell ID），
   给"确实要起服务器"的场景一条正路；配合工具描述引导：验收用一次性命令，服务器交给用户启动。

---

## 问题 2（中危）：GLM-5.3 规则表声明可关闭思考，与官方文档直接矛盾

**现象**：GLM-5.3 的 UI 显示"关闭思考"按钮（`supportsDisable: true` → 按钮出现），
点击后请求携带 `thinking: { type: "disabled" }`。

**官方文档实锤**（docs.bigmodel.cn《深度思考》《思考模式》，2026-08-26 更新）：

> 注：GLM-5.3 不再支持关闭思考（API 请求中 thinking.type 传 disabled 将会报错），请确保开启思考。
> GLM-5.3 强制思考不能关闭。

即：GLM-5.3 是**强制思考模型**，`disabled` 直接抛异常；GLM-5.2 才支持 `disabled`。

**失配位置**：`shared/reasoning.ts:173`

```ts
{ providerId: "glm", modelPattern: /^glm-5\.[23]/i, capability: {
    control: "toggle-effort",
    supportedEfforts: ["high", "max"],   // ← 问题 3：缺 low
    defaultEffort: "high",
    requestStyle: "thinking-type",
    supportsDisable: true,                // ← 问题 2：5.3 不能关
} },
```

**修复方向**：拆分 5.2 / 5.3 两条规则——

- `glm-5.3`：`control: "fixed-on"`（强制思考），`supportsDisable: false`，
  `supportedEfforts: ["low", "high", "max"]`，`defaultEffort` 建议 `"high"`（官方默认 max 偏重）。
- `glm-5.2`：保持 `toggle-effort` + `supportsDisable: true`；
  官方支持 `max/xhigh/high/medium/low/minimal/none`（none/minimal = 放弃思考），按需对齐。

同步更新 `reasoning.test.ts`：5.3 断言 fixed-on、5.2 断言可关闭。

---

## 问题 3（中危）：auto 档思考爆炸——auto ≡ max 的语义陷阱

**现象**：GLM-5.3 多步骤工具任务中，思考偏好为**auto**时单轮思考即可吃满输出预算，
出现 `finishReason=length`、正文为空只剩"⚠️ 模型输出达到长度上限"的回复
（fpsgame 会话 2026-08-26 15:17 实录，此时 1.1.5 已含 62a4ed1 的 maxTokens 修复，
即默认上限 65536 也被思考吃穿）。用户实测**显式 high 档无此问题，切到 auto 才爆炸**。

**根因**（用户实测 + 代码 + 官方文档三方对齐）：

1. `vendors/reasoning.ts:86-88`：`auto` 模式**不发送任何推理字段**——
   本意是"交给服务端自动判断"。
2. 但 GLM-5.3 是强制思考模型（问题 2），服务端默认 `reasoning_effort = max`。
3. 所以对 GLM-5.3：**auto ≡ max**。"自动判断"的语义在强制思考模型上坍缩成"永远最强档"。
4. 多步任务 × 交错式思考（每轮工具结果后继续思考）× max 档 → 思考总量爆炸，
   单轮即可吃穿 65536 输出预算。

**参照**：同为 GLM-5.3 的其他 agent（如 Trae）思考量明显更小——同一模型，
思考量由 `reasoning_effort` 决定；按轮调节档位即可控制，模型本身不是问题。

**修复方向**（三层互补，参数硬约束为主、prompt 软引导为辅）：

- **A. 规则层（治本）**：强制思考模型（`fixed-on`）上 auto 失去意义，
  规则表增加 auto 档映射（如 `autoEffort` 字段，auto 时发 defaultEffort 而非省略字段）；
  同时问题 2 拆规则时补入 low 档（官方 5.3 支持 low/high/max），用户可显式降档。
- **B. Prompt 层（用户提议，软引导）**：`tool_usage.md` 增加"循环意识"提示——
  告知模型当前处于 agent 工具循环中，每轮只需决定下一步动作并执行，
  不必在单轮思考中规划全局或预演所有后续步骤；计划已定则执行轮少想。
  作用是让思考内容聚焦当前步（减少重复规划），但无法像 effort 参数那样硬性砍预算。
- **C. 轮级思考（进阶，官方 GLM-4.7+ 能力）**：Harness 主循环按轮次发档——
  例行工具执行轮 `low`，规划/汇总轮 `high`，复杂决策轮 `max`。
  官方文档《轮级思考》明确支持同一会话每轮独立开关/调档，适合 Agent 场景。

**Prompt 措辞草案**（落点：`prompts/tool_usage.md` 工具使用一节，B 方案）：

> 你运行在多轮工具循环中：调用工具 → 看结果 → 决定下一步，逐步逼近目标。
> 每一轮思考只需要覆盖「下一步做什么、为什么」；不要在单轮里规划完整任务、
> 预演后续所有步骤或反复验证已有结论——后面的轮次还有机会思考和修正。
> 计划已经确定的执行阶段，直接做。

---

## 施工批次建议

- 批次 1（问题 1 P0）：双计时器 + 强制 resolve，`built-in-tools.ts` 单文件约 30 行，风险最低。
- 批次 2（问题 2+3 规则部分）：拆分 glm-5.2/5.3 规则 + 补 low 档 + 测试断言，纯表项更新。
- 批次 3（问题 1 P1/P2）：取消杀进程树；background 参数与工具描述引导。
- 批次 4（问题 3 进阶）：轮级 effort 策略，涉及 Harness 主循环，单独评审。
