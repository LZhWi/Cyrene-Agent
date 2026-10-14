# FurinaKit 本地文件工具接入

实现位置：`local-plugins/plugins/furina-file-tools/`，服务源码位于同级工作区的 `FurinaKit/cyrene-api/`。当前上游为 FurinaKit 2.1.2，固定提交 `9fd01cdcab71d36b23e32f2f0323f3e62f72bb6a`；最初接入版本为 `92960fce2ac0ab8d8a74194f20e03bd264645dd0`。插件当前版本为0.3.0。

只接入 work/code/learn。新增独立插件；没有修改宿主模式逻辑、聊天提示词、companion-chat 或 companion-memory。默认停用，工具执行入口拒绝 chat 或缺少模式的调用，包括人为覆盖工具可见性的情况。

## 本机使用

依赖已经隔离安装到 `E:\Philia093 demo\FurinaKit\.cyrene-runtime\python-packages`。

1. 在 Cyrene 插件页添加 `local-plugins/artifacts/furina-file-tools.zip` 并启用。
2. 插件设置填写以下路径：
   - FurinaKit 源码目录：`E:\Philia093 demo\FurinaKit`
   - Python：`C:\Users\ASUS\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`
3. 在 work/code/learn 会话选择工作区，将处理文件放在该目录内。

运行时是 Codex 当前自带的 Python 3.12.14；如果以后清理或迁移该运行时，可改用独立 Python 3.10+，先执行 FurinaKit 的 `cyrene-api/setup.ps1 -Python <新解释器路径>`，然后更新插件设置。

服务在第一次合法工具调用时自动启动，停用时关闭；无需提前启动工具箱或单独开终端。首批支持图片压缩、缩放、格式转换、PDF 合并与拆分。任务产物保存在会话工作区 `.furinakit-output/<任务ID>/`，提交返回任务ID，查询返回进度阶段、产物路径或失败原因。

首版使用 FurinaKit 现存 Python 兼容处理模块。API 未启动 Tauri UI，也未移植其 Rust 原生引擎；Pillow/PyMuPDF 保留各自许可，具体许可和接口说明见 FurinaKit 的 `cyrene-api/README.md`。

## 手动操作入口（0.2.0）

插件卡片的“打开”按钮，以及插件设置中的“打开文件工具面板”按钮，均可打开独立窗口。选择工作区、操作、文件和参数后：

- 点“直接执行”即可直接使用本机 API，不经过模型。
- 点“让模型执行”会调用宿主模型启动独立 Work 任务；两个专用工具限定为本次选定操作及其状态查询。参数和文件固定，模型无法替换选择，重复调用不会产生重复处理。
- 面板自动刷新任务状态，可取消任务，在完成后定位产物文件；PDF合并可调整文件顺序。

此模型入口使用现有 `llm.runGoal`，不向当前会话自动发送消息，不新增 chat 工具或修改聊天系统。自然语言调用路径仍只面向 work/code/learn。模型若未调用工具，面板会明确显示未处理文件；不把模型回复当作文件处理成功的证据。

## 构建与验证

在 `local-plugins/` 执行：

```powershell
node scripts/build-furina-file-tools.mjs
$env:FURINA_API_SOURCE = 'E:\Philia093 demo\FurinaKit'
$env:FURINA_API_PYTHON = 'C:\Users\ASUS\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
node node_modules/vitest/vitest.mjs run --config vitest.config.mjs plugins/furina-file-tools tests/furina-host.test.ts --maxWorkers=2
```

在 `FurinaKit/` 执行：

```powershell
& 'C:\Users\ASUS\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' .\cyrene-api\test_api.py -v
```

2026-10-02 验证结果：

- API 8/8 测试通过，实际验证图片尺寸、格式、透明区白底转换，PDF 页数、页序与文本，原文件 SHA-256 保持不变。
- 插件与真实宿主 PluginManager 的 ZIP 隔离加载测试 5/5 通过；work/code/learn 可调用，chat 被拒绝，停用后工具与自有 IPC 注销。
- 新插件源代码及这两个测试文件的定向 TypeScript 检查通过；ZIP 构建通过。
- API 认证、工作区边界、坏文件、越界页码、重复提交、排队取消与执行中取消测试通过；验证服务退出后未发现遗留 API Python 进程。
- 测试运行在两个项目的隔离目录，没有安装到正式用户数据，也没有调用实际聊天模型。尚未验证原生 Electron 界面的安装交互及模型自动选工具过程。

本次检查仅覆盖新增集成，不代表整库已有未提交变更通过全量回归。

2026-10-03 手动入口验证：

- Furina 插件、手动控制器、界面行为和真实 PluginManager 的定向测试 13/13 通过，新增代码定向 TypeScript 检查通过，0.2.0 ZIP 构建通过。
- 隐藏的原生 Electron 面板使用实际打包 UI/preload/IPC 和本机 API，直接执行及模型入口均产出真实图片；直接路径模型调用为0，模型路径合成任务调用为1，重复工具调用仍总共只创建2个文件任务。
- 模型入口使用合成 `runGoal` 验证；没有向实际模型服务发请求，真实模型遵循工具调用的效果仍未验证。此验收不包含正式用户环境的安装与启用。
- 原生结果及截图保存在 `local-plugins/.test-runtime/furina-panel/result.json` 和 `panel.png`。检查过程中没有修改 companion-chat 或 ChatComposer。

运行原生面板验收（需预先构建并设置上述两个环境变量）：

```powershell
& '..\node_modules\electron\dist\electron.exe' '.\scripts\furina-panel-smoke.cjs'
```

## 2026-10-12 更新与 HTML 接入

FurinaKit 已通过 `fetch` + `merge --ff-only` 从 `92960fce` 更新到 `9fd01cdc`（2.1.2）。保留本地 `.gitignore` 隔离目录规则、`cyrene-api/`、隔离Python依赖和 Cyrene 插件，没有更新正式用户环境的插件安装或模型设置。

新增 `html-to-pdf` / `html-to-image`，自然语言工具和两个手动入口均可用。面板选择HTML文件后，可选择：

- **按网页排版导出**：静态HTML转换成PDF或PNG。支持中文、CSS、工作区内图片和内嵌图片；PDF可横向，PNG可指定宽高，长网页需增大高度。
- **提取原图**：按img元素顺序去重，生成每图一页的PDF或保留原图片格式。支持src/data-src/data-original；不提取CSS背景图或SVG。文本页面应使用网页排版方式。

HTML和资源均须在工作区内；网页渲染不执行脚本或加载远程资源。导出使用系统Edge/Chrome的独立临时配置目录，不使用日常浏览器登录状态。取消和超时会终止任务自有进程树。HTML接入没有增加Python依赖。

验证结果：

- API回归14/14通过，涵盖原图片/PDF功能、HTML中文PDF文本、CSS截图像素与尺寸、横向PDF、原图顺序/去重/字节一致性、工作区边界和Windows自有进程树终止。
- 插件定向测试16/16通过，包括chat拒绝、真实PluginManager加载、新HTML参数及两个手动按钮；定向TypeScript检查通过。
- 原生Electron隐藏面板完成旧图片及4个HTML组合：PDF排版直接执行、PNG排版模型执行、原图直接导出、原图PDF模型执行。共创建6个文件任务，合成模型运行3次，无渲染脚本错误。
- 模型入口仍使用合成runGoal验收，未向真实模型服务发请求。不是整库回归或完整FurinaKit桌面程序构建验收。

升级前API、插件源码与Chat代码哈希基线备份：`E:\Philia093 demo\.codex-validation\furina-update-20261012-1bbbe723`。
