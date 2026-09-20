# 主程序最小补丁范围（2026-09-20）

## 原则

主程序只提供稳定边界、生命周期和桌面 Chat 路由；人格、记忆算法、WorldBook、life-context、屏幕策略、
天气评分和主动消息决策留在插件。Work、Code、Learn、朋友圈与渠道不移植本地实现。

## 必需补丁组

1. **Plugin API 与兼容文档**
   - `packages/plugin-sdk/src/api.ts`、两份 manifest schema、SDK 构建脚本及 `docs/plugins/`。
   - 增加稳定／动态 Prompt 层、消费回执、成功轮次事件，以及受限的会话、主动投递、屏幕观察、
     用户状态和天气服务；旧插件的缺省语义保持不变。

2. **宿主服务与生命周期**
   - `src/main/plugin-host/`、`src/main/plugin-runtime.ts`、`src/main/application/default-dependencies.ts`。
   - 服务由单一工厂注入；最终消息真正落盘后才发布提交事件。截图、位置、密钥和宿主私有文件不暴露给插件。

3. **桌面 Chat 后端与两阶段管线**
   - `src/main/orchestrator/chat-backend.ts`、`build-options.ts`、Harness／adapter／run-capabilities、
     `agent-runtime.ts`、`cyrene-agent.ts`、`tone-injector.ts` 和相关测试。
   - 只在桌面 Chat 的 companion 后端执行 Tool→Soul；原生后端与其他模式沿用上游路径。

4. **冲突系统旁路与状态快照**
   - `agui-bridge.ts`、聊天存储／IPC、原生关系与主动消息门禁、Prompt Registry。
   - 每轮开始冻结后端；companion 不双读／双写原生记忆、关系、WorldBook、历史 RAG 或主动消息。

5. **必要的宿主 UI**
   - preload、ChatPage／AgentRunController、导航状态、消息忽略反馈、设置页与翻译资源。
   - 只提供后端选择、状态显示和一次性反馈动作；插件窗口继续承载算法配置与维护 UI。

6. **窄能力实现**
   - `assistant-delivery-service`、`screen-observation-service`／diff、`user-presence-service`、
     `weather-context-service` 与天气只读观测。
   - 屏幕变化比较排除桌宠动态区域；天气只返回不含位置的结构化有效快照。

## 不属于补丁

- `local-plugins/artifacts/*.zip` 是安装产物，不是主程序源码。
- `dist/renderer/toast/index.html` 是已有构建输出差异，发布源码补丁时应排除；本轮未为清理它修改产品代码。
- 手动话题边界、记忆命名空间迁移、模型日程／日记／朋友圈联动是后续新增设计，不加入当前补丁。

## 后续同步策略

跟进上游时按上述六组分别重放并测试，不整体替换上游模块。优先保留上游 Harness 内部演进，只维护
`chatBackend` 分支、Prompt Provider 层、生命周期回执和四个受限宿主服务的装配点。
