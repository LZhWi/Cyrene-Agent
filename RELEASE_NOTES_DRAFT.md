# Cyrene-Agent Release Notes

> 自上次推送（`3bb1cc4` · 2026-07-08）以来的 65 个 commit。

## 偏好设置 UI
- **偏好设置面板右侧按钮组对齐**：每个设置项右侧的选项按钮组现在锁定为 3 列、宽度统一，所有行（包括"分段输出""主动聊天"等 2 按钮的行）右边界对齐到同一竖线，空列保留在左侧，不影响其它面板。`#preferences-form` 内 CSS 改动。

## 主动聊天（Proactive Chat）
新增端到端能力，含 UI、运行时与渠道三层：
- 设置面板接入"主动聊天开关 / 主动消息发送到（本地 / 微信 / 飞书）"。
- 运行时新增 hardened policy、guarded prompt、tool-free model runner、proactive session singleton 等安全护栏。
- 路由与会话：未启用渠道时取消发送并保留状态，桌面端可投递，移动端预检后再发。
- 偏好设置新增"主动消息发送到"。

## 聊天流式分段与图片附件
- 聊天回复流式分段开关可设"所有 / 仅聊天 / 关闭"，并在气泡渲染时按句拆分。
- 聊天历史改为分页读取、会话尾部写入、`agent:system` 窗口仅取近期上下文；新增消息时间上下文注入。
- 图片附件直接发送给支持 vision 的主模型；文档附件在发送时处理，并避免索引过程的内存峰值。

## 聊天通道（手机连接）
- TTS 音频不再写入微信；微信侧支持图片/表情包/文件/视频通过 ilink 上传，silk 语音编码通路。
- 收到图像/文件/视频后按类型分类下载，无支持类型时拦截；语音消息用 ASR 转写；用户在聊天窗口请求时把入站文件保存到桌面收件箱。
- 修复图片发送策略、reply 路由到 adapter send 两个回归。

## Reasoning / Provider
- 引入按模型能力推理层（model-aware reasoning capability）。
- 聊天面板的推理档位下拉改为基于能力的动态菜单。
- `PROVIDER_CAPABILITIES` 用 `satisfies` 类型守卫；新增流式 reasoning + 多轮 tool_calls 的端到端测试。
- 接入 Xiaomi MiMo provider；启用 Claude provider 并加入 `fable-5` 旗舰模型。

## 性能与稳定性
- RAG：embedding 在后台 worker 队列批处理、结果缓存、按 batch 写入并流式输出；启动时缓存索引并延迟预热。
- 聊天：`document context` 排除副作用 embedding；图像 caption 延迟到发送；文档索引与回复同步。
- 资源释放：长生命周期 renderer 资源在窗口关闭时回收。

## Live2D / 表情包 / 启动
- Live2D pet 窗口拖动稳定性。
- 表情包被加入 outgoing message parts；缺语音包时主动开口给出明确告警。

## 设置面板 / 主题
- 外观设置：桌面图标预设可选；主题与自定义字体可设。
- 聊天面板在白色主题下 dropdown 选中项 / 空态文本颜色可读。
- 设置项文本输入框在 IME 输入时不被中断。

## 工程与仓库
- 拆分 system prompt 为 `tool_system` 与 `soul_systemBase`；聊天表达规则改写、禁止动作描写旁白。
- `.gitignore`：显式忽略 `models/Xenova/` 及权重文件；忽略 worktree 与 zcode workspace；移除 `docs/` 目录。

## 工具与开发
- TTS + AGUI 集成（`807773d`）。
- 通话 VAD 阈值下调并提供调试日志与 LLM 超时。
- Channels 模块：TTS / dispatcher / Feishu 音频通路日志；工具沙箱默认"all"+ UI 单选组。

---
`fix(preferences)` / `feat(chat)` / `feat(proactive)` / `feat(wechat)` / `feat(provider)` / `perf(rag)` 等多个 commit，散布在 master 上等待下一次推送。
