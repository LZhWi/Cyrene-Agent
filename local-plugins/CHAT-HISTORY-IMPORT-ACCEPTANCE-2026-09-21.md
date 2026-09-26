# 原有聊天记录正式导入验收（2026-09-21）

## 导入边界

- 源目录只读：`C:\Users\ASUS\AppData\Roaming\live2d-cyrene\cyrene-chats`。
- 目标目录：`E:\Philia093 demo\Cyrene-Agent-N\AppData\Roaming\live2d-cyrene-n\cyrene-chats`。
- 原有 N 会话先完整备份，再以候选目录原子替换；未覆盖同 ID 会话。
- 旧会话显式转换为 `mode: "chat"`，避免被上游的通用旧数据迁移误归到 Work。

## 导入结果

- 新增历史 Chat 会话：1 个。
- 历史消息：1508 条，其中用户 677 条、模型 831 条。
- 消息 ID 与时间戳：全部存在且会话内唯一。
- N 中会话总数：2 个；原有 1 个 Work 会话保留。
- 可用附件：77 个，共 156244969 字节，复制后逐文件 SHA-256 一致。
- 缺失附件：1 个；源文件在导入前已经不存在。目标只保留不可用占位并标记 `error`，不再引用源路径。
- 所有历史附件路径均重写到 N 自有 `cyrene-chats/imported-assets` 目录。
- 源聊天结构哈希：`f6ded1b65367ecb12669e9fe5e6047793f9d056c947daecc539cb6663f5b109e`，正式导入前后相同。

## 上游运行时验证

- 使用 Electron 和真实 `chats-store` 加载 N 正式数据的临时副本。
- `listSessions({ mode: "chat" })` 返回 1 个历史 Chat 会话。
- 完整会话读取为 1508 条消息。
- 分页读取返回 100 条，`hasMore=true`，总数为 1508。
- 运行时读取没有改动正式 N 聊天目录，也没有改动临时副本。
- 测试退出前已显式清理副本；最终残留临时聊天目录为 0。

## 用户可视验收

- 用户于 2026-09-21 启动正式 N 数据目录确认：Chat UI 显示正常，原有消息记录已同步出现。
- 可视验收后再次执行逐条只读对账：1508 条消息与 77 个可用附件仍通过，源结构哈希保持不变。

## 恢复点与审计

- 导入前备份：`E:\Philia093 demo\Cyrene-Agent-N\ChatImportBackups\2026-09-21T03-36-10-248Z-a094fd05-afed-494b-bbe4-60350795cb2f\cyrene-chats`。
- 机器可读报告：`E:\Philia093 demo\Cyrene-Agent-N\ImportReports\2026-09-21T03-36-10-248Z-a094fd05-afed-494b-bbe4-60350795cb2f-chat-history.json`。
- 导入与复核脚本：`local-plugins/scripts/import-legacy-chat-history.mjs`。
- Electron 运行时验证：`local-plugins/scripts/verify-imported-chat-runtime.cjs`。

报告不包含会话标题、消息正文、附件文件名或模型回复正文。
