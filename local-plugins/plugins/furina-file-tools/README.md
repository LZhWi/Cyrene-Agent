# Furina 本地文件工具

仅在 work / code / learn 模式注册推荐工具，并在执行入口硬性检查模式。需要为会话选择工作区；输入文件必须在该工作区内。插件不注册聊天渠道、提示词提供者或后台对话监听。

## 安装

1. 获取带 `cyrene-api/` 的 FurinaKit 源码，使用 Python 3.10+ 执行 `cyrene-api/setup.ps1 -Python <python.exe绝对路径>`。
2. 在 Cyrene 插件页添加 `furina-file-tools.zip` 并启用。
3. 在插件设置面板填写 FurinaKit 源码目录和同一个 Python 可执行文件的绝对路径。
4. 在 work / code / learn 会话选择工作区，把需要处理的文件放在该目录内，然后调用文件工具。

## 手动入口（0.2.0）

启用后，在插件卡片点击“打开”，或在插件设置中点击“打开文件工具面板”。在独立面板中选择工作区、操作、文件和参数：

- **直接执行**：直接调用本机 API，不调用模型；面板自动查询结果，支持取消与“在文件夹中显示”。
- **让模型执行**：使用宿主 `llm.runGoal` 运行独立 Work 任务。模型只得到两个专用工具：执行本次已选操作、查询这个任务。文件、参数和操作在开始时固定，模型无法改为其他操作；重复调用只提交同一个任务。面板显示实际处理状态及模型说明；模型仅回答而不调用工具时会明确显示“未处理文件”。

PDF 合并的文件列表可上移、下移，输出顺序以列表为准。模型任务会将所选路径和参数交给宿主当前模型；不支持 `runGoal` 的旧宿主会禁用模型按钮，直接执行仍可使用。手动面板独立于聊天会话，模型按钮固定运行 Work 任务，不修改 chat 系统。

服务在首次工具调用时启动，仅监听 127.0.0.1 的随机端口，认证令牌每次启动随机生成。停用插件会停止自有服务并取消其未完成任务；原文件和已生成产物保留。

## 首批功能

- `image-compress`：单张图片，`quality` 1..95（默认75），可选 `max_width`；输出JPEG，透明区域垫白底。
- `image-resize`：单张图片，至少提供 `width` 或 `height`（1..16384），`keep_ratio` 默认true。
- `image-convert`：单张图片，`format` 为 png/jpg/webp/bmp/tiff。
- `pdf-merge`：2..32 个PDF，按输入顺序合并。
- `pdf-split`：单个PDF，`ranges` 使用从1开始的页码，例如 `1-3,5`；每段生成一个PDF。

## HTML 导出（0.3.0 / FurinaKit 2.1.2）

面板新增 **HTML → PDF** 和 **HTML → 图片**。这两项都支持“直接执行”和“让模型执行”，会话中的模型工具 `submit` 也支持 `html-to-pdf` / `html-to-image`：

- **按网页排版导出**（`method: "render"`，默认）：系统 Edge/Chrome 渲染静态 HTML，保留中文、CSS 和图片。PDF 可选横向；PNG 可指定图片宽高（默认1200×900），长页面可增大高度。等待加载默认1500毫秒。
- **提取原图**（`method: "extract"`）：按 img 元素顺序提取内嵌或本地原图，去重；合成PDF时每图一页，导出图片时保留原格式。此模式不传宽高、横向或等待参数。

HTML及其图片、CSS等资源需位于所选工作区内；支持内嵌图片。此入口仅处理静态本地内容，不执行脚本或加载远程资源。渲染需要本机安装 Edge 或 Chrome，不需要新增Python包。停用插件会连同自有渲染浏览器一起停止任务。

`furina-file-tools_catalog` 查询服务和参数；`submit` 返回任务ID；`status` 查询状态及产物绝对路径；`cancel` 取消任务。产物保存到工作区 `.furinakit-output/<任务ID>/`，每次创建新目录，不覆盖输入。

API复用 FurinaKit 的 Python 兼容处理模块，而非 Tauri Rust 模块。保留上游MIT声明；Pillow、PyMuPDF遵循各自许可，PyMuPDF为AGPL/商业双许可。该插件包只包含客户端，不捆绑上游、Python或第三方依赖。
