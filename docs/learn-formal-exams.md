# Learn 正式试卷

本次只迁入 Learn 专用流程，参考上游固定提交 `a4f2306b8233105db6ff80ba0865b13818044044` 的试卷类型、分阶段草稿校验、持久化和评分工具。没有引入共享浏览器控制 / Harness，也没有覆盖工作区知识改造。

## 使用

1. 打开“工作/学习”，进入 Learn 会话，要求生成正式试卷并确认命题蓝图。
2. 模型创建计划，按题型写题，完成配额后发布。支持单选、多选、判断、填空、简答和解答题。
3. 发布后打开独立答题窗口；题号导航显示完成进度，可切换上一题/下一题及标记待检查。导航和标记保存到所绑定试卷，答案逐次串行保存。交卷先等待答案及导航保存完成，保存失败会阻止交卷并显示重试入口。
4. 确认交卷后答案冻结。在所属 Learn 会话的试卷栏点击“开始批改”，发起新轮次；模型读取冻结答案并保存结构化评分。切换到别的模式不会将批改发送到 Chat。
5. 中止、失败或未保存评分的批改结束后标记为可重试；进程中断的 grading 状态在下一次 Learn 试卷管理使用时恢复为 grading_failed。

## 隔离边界

- `learn-exams/` 与 `learn-exam-drafts/` 位于当前宿主 userData。仅使用试卷时创建；不连接聊天 RAG、L0/L1/L2、图片索引或 companion 插件。
- 草稿按会话和 run 双重绑定，24 小时有效，最多 200 题。发布须题量、题型分值与总分一致。
- 管理 IPC 仅允许工作/学习窗口的主 frame 操作 Learn 会话；模型工具另有不可被工具模式配置覆盖的运行时 Learn 检查。
- 独立答题窗口使用非持久化 session、沙盒及专用窄 preload；只读写所绑定试卷，不暴露通用 settings / chatStore / agui API。资源协议限定本试卷和打包 assets，阻止路径穿越、跳转、弹窗、下载和权限申请。
- 试卷文件保持临时文件加原子替换；遇到 Windows 的 EPERM/EBUSY 最多尝试 5 次，不删除旧记录。持续失败向页面报错，阻止未保存交卷，可手动重试保存。
- 作答视图不包含参考答案、解析或评分细则；交卷后仅批改工具能读取完整私有记录。

## 与上游的明确适配

此版本不是上游 UI 的逐项复制：使用独立窗口和 Learn 会话中的手动批改入口，已加入答题导航、进度和待检查标记，仍未迁入右侧浏览器、折叠题型等完整排版。Markdown、数学公式和代码围栏保留；现有知识工具和 prompt 段保留。

## 验证

- `npm test -- src/main/learn/exam-draft.test.ts src/main/learn/exam-integration.test.ts src/main/orchestrator/learn-exam-tools.test.ts src/renderer/learn-exam-answer-queue.test.ts`
- `npm run build:main`、`npm run build:preload`、`npm run build:renderer`
- `node scripts/verify/learn-exam-smoke.mjs` 使用独立临时 userData、六题合成试卷和合成评分；不调用 LLM。验证原生资源加载、权限隔离、导航/标记保存、实际作答保存/交卷冻结、评分刷新、关闭重开，以及现有 JSON 文件哈希。

实际主模型能否按计划正确命题和批改尚未调用验证；工具与 UI 的确定性流程由测试覆盖。
