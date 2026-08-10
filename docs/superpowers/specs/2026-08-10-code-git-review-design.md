# Code Git 审阅设计

## 目标

为 Code 模式提供轻量 Git 工作台：昔涟可通过对话执行 Git 操作，界面只展示变更、分支、提交或推送，并可只读审阅文件差异。

## 边界

- Git 只属于 Code 模式；Work、Chat、Learn 不显示或调用 Git 工作台。
- 用户对昔涟说“初始化仓库”“提交”“切换分支”“回退”时，昔涟通过受控 Git 工具执行；写操作沿用权限确认。
- 不做 IDE：不提供编辑、终端、文件树、多标签代码编辑或比较分支功能。
- 初版不自动初始化仓库；用户明确请求后才执行 `git init`。

## Git 可执行文件

GitProvider 按以下顺序解析可执行文件：

1. 可执行的用户系统 Git；
2. Release 中随包携带的 Windows MinGit；
3. 不可用状态，Code Git 区显示安装/可用性说明。

系统 Git 优先，以保留用户自己的凭据、全局配置、Git LFS 与企业证书环境。MinGit 只作为 Release 的 Windows 可靠兜底，不读取或覆盖用户配置。

## 界面

Code 侧栏 Git 区只包含：

- 变更：新增、修改、删除数量和变更文件列表；
- 分支：当前分支与切换入口；
- 提交或推送：未提交、待推送状态与总入口。

不显示“本地”分组、比较分支或 PR 状态。

点击变更文件后打开只读审阅面板。主进程执行 `git diff --no-ext-diff` 取得 unified diff；renderer 使用 `react-diff-view` 渲染。默认 unified 单栏，用户可切换 split 双栏；不允许编辑。

## 数据与安全

- 主进程负责仓库探测、Git 命令执行、输出规范化和错误分类。
- renderer 仅消费结构化状态和 unified diff，绝不直接执行 shell。
- 每次打开 Code 会话、Git 工具完成后、用户手动刷新后刷新状态。
- 非仓库、缺少 Git、权限拒绝、命令失败都显示为状态，不伪装成空仓库或成功。

## 验收

1. 有系统 Git 的 Code 会话使用系统 Git；Release 缺系统 Git 时可使用 MinGit。
2. 变更文件可打开只读 unified diff；切换 split 不改变内容。
3. Work、Chat、Learn 不出现 Git 工作台。
4. 初始化、提交、分支切换、推送经昔涟工具和既有权限机制执行。
5. 无 Git 或非仓库时显示可理解的降级状态。
