# 正式数据导入与副本验收（2026-09-21）

## 结论

正式记忆和旧向量已导入 `Cyrene-Agent-N` 独立 AppData。导入前先在同盘 staging 完成全流程彩排，
正式提交采用 staging 完成后替换，并保存完整导入前 AppData 备份。源文件始终只读。

正式库保持 `chatBackend=native`；插件已经安装并启用，但记忆读取、自动提取、Prompt 注入和 DMAE
仍维持默认关闭。因此本次导入本身不会改变聊天行为或激活值。

## 导入结果

- L2：152 条；有效 152，无效 0，重复 ID 0。
- 状态：active 115、merged 7、archived 18、superseded 5、aging 7。
- 证据：146 条；无孤立、删除或重复记录。
- facets：152 条全部有效。
- L0/L1：4 + 3 项。
- 生命周期记录：152 条。
- 旧 DMAE 状态：132 条，完整映射，无孤立状态。
- 旧向量：122 条，全部为 1024 维，与已导入 L2 全部对应。
- 来源声明：用户确认旧库已经过独立验证；没有伪造空缺的原始消息 ID。

## 副本验收

`scripts/verify/formal-companion-import.cjs` 会复制当前 `-N/AppData` 到一次性目录，只在副本内运行。
最终结果：

- `lexicalRecall=true`
- `promptInjection=true`
- `receiptCommittedInCopy=true`
- 152 条记忆、146 条证据、122 条向量、1024 维结构核对通过。
- 在副本中开启 DMAE 后，只有宿主确认 Prompt 已完整接收且回复成功落盘，才提交工作集变化。
- 正式导入库前后内容哈希一致。
- 测试副本和临时父目录已删除。

语义向量完整性和 L2 对应关系已经验证；本轮没有配置独立 Embedding Provider，因此没有发起新的查询向量请求，
也没有重建或覆盖旧向量。

## 隔离结果

正式源与其他保护根最终内容哈希：

| 保护根 | SHA-256 |
| --- | --- |
| `%APPDATA%/live2d-cyrene` | `ea4a408c367990937a23850d1c714b9d40659ae5a0e796822a9ecd159bf8ca22` |
| `%LOCALAPPDATA%/live2d-cyrene` | `a4004f151c8bd852ca176e9b14b9b8b6514b8d48fb1bb2b81d13c3c5a486ed8a` |
| `Cyrene-Agent/UserData` | `a4004f151c8bd852ca176e9b14b9b8b6514b8d48fb1bb2b81d13c3c5a486ed8a` |
| `Cyrene-Agent/UserData_backup` | `da9c3f2a5a43b21976b5fefe7ebd836cf6d2ea776c9528c667c48f959e3c87e5` |

导入前完整备份：

`E:\Philia093 demo\Cyrene-Agent-N\AppData_import_backup\2026-09-21T02-54-33-785Z-a09de592-ba02-4ba9-9677-693a3f3ed8b7\AppData`

结构化导入报告：

`E:\Philia093 demo\Cyrene-Agent-N\ImportReports\2026-09-21T02-54-33-785Z-a09de592-ba02-4ba9-9677-693a3f3ed8b7.json`
