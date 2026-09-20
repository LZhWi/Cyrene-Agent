# Chat／Collab 分阶段提示词验收（2026-09-20）

## 范围

本轮只处理桌面 `companion` Chat 的三个提示词差距：本地 Tool 记忆检索规则、动态语气规则和最终
Soul 近端锚点。没有访问或复制真实用户数据，没有启动原始 `Cyrene-Agent`，写入范围仅在
`Cyrene-Agent-N/.upstream-latest`。

## 已实现

- `companion-chat` 0.11.0 打包本地当前 `tone-rules.md` 与 `tone-anchor.md`；换行归一化后与只读源文件
  内容完全一致。
- 新增稳定提示词目标 `tone` 和 `soul-tail`。`tone` 仍由上游现有 scene embedding 匹配器组合场景
  样本；场景索引不可用时仅保留插件基础语气规则。
- `soul-tail` 与按用户时区格式化的当前时钟只在 Harness 关闭 Tool transcript 后交给最终无 tools 的
  Soul 请求，不进入 Tool 阶段、对话持久化或其他模式。
- Tool 提示词对涉及历史细节、稳定资料、长期偏好、持续目标及明确回忆意图强制调用
  `companion-chat_memory_search`。上游已删除的音乐展示工具规则没有恢复。

## 自动验证

- 主程序定向测试：4 个文件、118 个测试通过。
- 主程序 TypeScript 构建：`build:main` 通过。
- Plugin SDK 构建：`build:plugin-sdk` 通过。
- 插件完整验证：48 个测试文件通过、4 个跳过；312 个测试通过、11 个跳过；构建、隔离
  PluginManager smoke 与产物 smoke 全部通过。

根测试首次因本机 Electron 包缺少二进制且离线下载失败；使用只影响当前测试进程的
`ELECTRON_OVERRIDE_DIST_PATH` 后定向测试通过，未创建或启动 Electron 进程。完整 Electron UI 验收留到
本机 Electron 运行时恢复后执行。

## 隔离结论

本轮没有读取真实聊天、记忆或 activation 数据，也没有启动任何 Cyrene 进程；因此不会触发访问统计、
DMAE、记忆写入或原始用户数据刷新。生成物仅位于当前 `-N` 工作树及其 `local-plugins/artifacts`。
