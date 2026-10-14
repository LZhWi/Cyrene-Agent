# Work / Code / Learn 工作区知识

当前版本复用 Learn 的 Markdown 解析和 Vault 原子写入，增加文档章节导航、带原文证据的派生主题页，以及决策 / 进度 / 经验记录。仅作用于当前会话绑定的工作区；不连接 Chat、宿主用户记忆或 companion-memory。

## 使用路径

1. 用现有搜索、目录或 Obsidian 工具定位资料。
2. `workspace_document_outline` 获取章节树、原文摘录、行号及完整文件 SHA-256。节点使用 `parentId` 表示树关系，可用 `offset` / `limit` 分页。摘录是原文，不是模型摘要。
3. `workspace_document_read` 按节点 ID 和相同版本 hash 读取原文；按需读取子章节或相邻章节。返回 `nextOffset` 时继续分页，避免将截断误判为原文不存在。
4. `workspace_knowledge_list` / `workspace_knowledge_read` 查已有派生知识。read 每次重新校验来源，不使用执行账本里的旧读取结果。
5. 当前 Agent 整理正文后调用 `workspace_knowledge_save`。来源附相对路径、原文 hash、章节 ID 和逐字引文；正文按来源顺序引用 `[S1]`、`[S2]`。工具没有独立后台模型调用。

## 存储与维护

```text
cyrene-knowledge/
  topic/<slug>.md       跨文档主题知识
  decision/<slug>.md    项目决策与依据
  progress/<slug>.md    重要任务里程碑与待办
  lesson/<slug>.md      成功经验、失败尝试及边界
```

Markdown 的 JSON/YAML frontmatter 保存 schema、类别、标题、更新时间和来源，正文可用相对 Markdown 链接关联其他页面。没有另一份必须同步的索引或数据库；目录可通过知识列表重建。页面是派生资料，原始代码、文档和已有 Learn 进度文件仍保留。

- topic 至少有一条原文证据；记录类可无证据，但标为 `unverified_record`，不能据此声称已验证事实或任务完成。
- `quotes_validated` 仅表示所列引文确实位于指定版本的原文中；不保证正文推论正确，也不保证每条结论都得到充分支持。
- 原文变化、删除或不可读时，read 返回 `stale=true` 和每条来源状态。先重读原文，再更新页面；不静默沿用旧结论。
- 更新必须先读取页面并提供完整 `expectedContentHash`；同一页面的进程内写入串行，避免两个 Agent 覆盖彼此的版本。
- 不覆盖无托管 schema 的页面，不把派生页再当作原始证据；不按期限清理来源，不自动扫描或批量生成全工作区 Wiki。
- 写入复用 Vault 的临时文件与原子 rename，并返回文件变更证据，沿用 fs-write 权限和 artifact 验证策略。
- 路径只能来自可信工作区上下文，拒绝逃逸及指向工作区外的链接，包括尚不存在文件的父目录。直接在 Chat 或缺少工作区上下文调用会失败。

## 模式分工

- Learn：教材 / 笔记章节导航和跨材料主题页。`notes/`、`exercises/` 和 `learn/progress.md` 的职责保持不变，不重复记录每轮学习进度。
- Work：长报告、项目背景、决策和任务里程碑。
- Code：需求 / 设计文档、设计决策和经验；不替代 AST、LSP、代码搜索或测试。

### Learn 工作区隔离

Obsidian 工具在启动时注册，执行时检查 Learn 模式并从可信运行上下文获取 Vault；运行结束不注销其他会话仍在使用的工具。Learn 开局固定工作区，后台进度提取结束后仍写回该轮的 Vault。相同 Vault 文件的编辑和进度增量合并共用进程内写入队列，避免跨会话串写和并发增量覆盖；读取工具返回完整 hash，并绕过旧读取缓存以支持冲突后重新读取。

隔离回归使用临时 Vault 和模拟提取结果，验证 A 的延迟更新不会写入 B、同一 Vault 的 20 个并发增量全部保留，以及旧 hash 更新被拒绝。未调用真实模型或读写正式学习数据。

## 当前范围与验证

支持最多 2 MiB 的有效 UTF-8 文本。Markdown 的 `#` 标题形成章节树，忽略代码围栏内的标题；其他文本只有 document 根节点。没有接入 PageIndex 的 Python SDK、PDF/OCR、向量数据库或额外摘要服务。PDF 和超限材料继续使用已有文档检索、搜索及文件分页工具。

借鉴 PageIndex 的章节导航、llm_wiki 的派生知识与来源关系，以及 memory-framework 的项目记录分类；不引入它们的自动日志、删除来源或额外审批规则。

测试使用临时工作区，覆盖真实工具注册 / 模式隔离、章节原文读取、引文与版本校验、工作区隔离、符号链接边界、冲突写入和取消。它们验证文件与工具链路；尚未证明相比现有混合检索有更高问答准确率，也没有真实模型延迟 / 成本或原生 Electron 体验对照。后续对照应使用经用户选定的长文档及带标准答案 / 无答案的问题，分别检查证据完整度、引用准确度、延迟和费用。
