# Windows 原生 Office Skills 整改设计

## 背景

Cyrene 当前内置四类 MiniMax 文档技能：PDF、DOCX、XLSX 和 PPTX。它们已经包含较完整的版式规则、中文排版知识、样式配方和格式校验能力，但部分执行入口仍面向 Linux：

- PDF 封面通过 HTML 和 Playwright 渲染，主入口是 Bash 脚本。
- DOCX 虽有 Windows 安装脚本，环境检查和预览入口仍主要是 Shell 脚本。
- XLSX 的 Python 脚本本身可跨平台，但技能文档大量使用 `python3`、`/tmp`、`grep` 和 Shell 管道。
- PPTX 主生成器可在 Windows 运行，但编辑和质量检查文档仍含 `/tmp` 等 Linux 假设。

本次整改保留 MiniMax 的设计资产，只替换或补齐不适合 Windows 的执行和验证层。

## 已选方案

采用“共享设计令牌 + 各格式原生执行器”的渐进式改造。

未选择的方案：

1. 不将四种格式统一改写为 OfficeCLI。该方案强依赖本机 Microsoft Office，且会放弃当前可离线、可测试的 OOXML 和 Python 能力。
2. 不用 Hermes 或其他通用技能整体替换 MiniMax。通用技能的文件操作能力较强，但现有 MiniMax 版式、中文规则和模板更完整。
3. 不删除 Cyrene 应用级 Playwright 依赖。`@playwright/mcp` 仍服务于用户主动开启的浏览器自动化；本次只消除 Office 文档生成流水线对 Playwright 的依赖。

## 目标

1. PDF、DOCX、XLSX 和 PPTX 的默认工作流可在 Windows PowerShell 中运行。
2. Office 文档生成不要求 Bash、WSL、GNU grep、`/tmp` 或 Playwright。
3. 保留现有 MiniMax 文档类型、版式配方、颜色体系和中文排版能力。
4. 将跨格式共有的颜色、字体、间距和语义角色收敛为共享设计令牌。
5. 每种格式保留自己的布局模型，不强行把 Word 页面、Excel 网格和 PPT 幻灯片做成同一种结构。
6. 每条生成或编辑流水线都有结构检查；视觉敏感输出还有渲染复检入口。

## 非目标

- 不重写 Cyrene 的技能注册或调用机制。
- 不移除浏览器自动化设置和 Playwright MCP。
- 不要求用户安装 Microsoft Office 才能创建文件。
- 不在第一阶段追求所有 PDF 封面与旧 HTML 渲染逐像素一致。
- 不更改已有文档时，不主动重排用户原有样式。

## 总体架构

```text
skills/office-design/
├─ SKILL.md
├─ assets/themes/*.json
├─ references/token-schema.md
├─ references/format-mapping.md
└─ scripts/validate_theme.py

skills/pdf/             ReportLab + pypdf + pypdfium2
skills/docx/            OpenXML SDK + .NET + PowerShell
skills/xlsx/            Python + OOXML + PowerShell 友好入口
skills/pptx-generator/  PptxGenJS + OOXML
```

共享层只定义品牌语义，不包含格式专属坐标：

- `primary`、`secondary`、`accent`、`background`、`surface`、`foreground`、`muted`、`border`
- 中文和英文字体候选及回退顺序
- 标题、正文、说明文字和数字的字号比例
- 4/8 点间距尺度
- 表头、数据输入、公式、警告、成功等语义角色
- 图表颜色序列和对比度要求

各格式负责把这些语义映射到自己的原生结构：

- PDF：ReportLab Canvas/Platypus 样式。
- DOCX：Word 样式、编号、节、页眉页脚和表格样式。
- XLSX：字体、填充、边框、数字格式、条件格式和图表主题。
- PPTX：母版式主题、页面背景、文本层级、形状和图表颜色。

## 子项目一：PDF 去浏览器化

### 执行流

```text
内容 JSON
  → palette.py 生成 tokens.json
  → render_cover.py 直接生成 cover.pdf
  → render_body.py 生成 body.pdf
  → merge.py 合并并做结构检查
  → render_preview.py 输出 PNG 供视觉复检
```

### 设计要求

- 新 `render_cover.py` 直接消费 `tokens.json`，不再生成或打开 HTML。
- 第一批覆盖现有 15 种封面模式：fullbleed、split、typographic、atmospheric、minimal、stripe、diagonal、frame、editorial、magazine、darkroom、terminal、poster，以及由文档类型映射到这些模式的现有入口。
- 使用 ReportLab 矢量图形绘制色块、网格、边框、分割线和几何装饰。
- 字体解析优先使用 Windows 字体目录；中文优先 Microsoft YaHei、SimHei、SimSun，英文回退到 ReportLab 内置字体。
- 换行依据实际字宽计算，不按字符数截断。
- 图片加载只接受本地文件或由现有受控下载流程落盘后的文件。
- `make.py` 成为跨平台主入口；保留精简 `make.sh` 作为兼容包装器。
- PDF Skill 文档默认展示 `python scripts/make.py ...`。

### 验证

- 单元测试覆盖参数解析、文档类型到封面模式映射、字体回退和字宽换行。
- 生成包含中英文、长标题、图片缺失和 15 种封面的样例 PDF。
- 使用 pypdf 检查页数、页面尺寸和非空文本层。
- 使用 pypdfium2 渲染每页 PNG；检查空白页、裁切、重叠和缺字。
- 断言 PDF 流水线代码及文档不再引用 `render_cover.js` 或 Playwright。

## 子项目二：XLSX Windows 化

### 执行流

现有 XML 解包、编辑、打包脚本继续作为底层实现。新增一个跨平台工作流入口，负责：

- 创建安全临时工作目录。
- 调用现有 unpack、pack、formula-check 和 style-audit 能力。
- 使用 Python 查找工作表标签和 XML 节点，替代 grep。
- 输出机器可读的 JSON 结果和明确退出码。

### 文档规则

- 命令统一使用当前解释器形式：`python scripts/...`。
- 示例使用显式 `<work-dir>`，不再假设 `/tmp`。
- Windows PowerShell 示例使用 `Join-Path $env:TEMP ...`。
- Linux/macOS 仍可运行底层 Python 脚本，但不再是默认说明路径。
- `libreoffice_recalc.py` 增加常见 Windows LibreOffice 安装目录探测。
- 如果 Microsoft Excel 可用，可作为未来可选重算后端；第一阶段不强依赖 Office COM。

### 验证

- 在包含空格和中文的 Windows 路径中完成 unpack → edit → pack。
- 验证宏、图表和数据透视相关的未修改 ZIP 条目保持不变。
- 覆盖标签查找、公式扫描、样式审计及 LibreOffice 路径发现测试。
- 扫描 Skill 主文档，禁止出现作为默认流程的 `/tmp`、`grep` 和 `python3`。

## 子项目三：DOCX Windows 验证闭环

DOCX 的 OpenXML SDK 和 .NET 实现保留。新增或补齐：

- `env_check.ps1`：检查 .NET 8、字体、可选 LibreOffice/Pandoc 和 CLI 构建状态。
- `docx_preview.ps1`：优先使用 Windows LibreOffice 路径导出 PDF/PNG；缺失时给出结构验证结果和明确提示。
- SKILL 默认命令改为 PowerShell；Shell 命令降为其他平台附录。
- 保留现有 13 种美学配方、5 套简单风格、CJK 排版和 XSD 门控。
- 新建文档必须选择一个明确样式配方；编辑已有文档默认保留原格式。

### 验证

- PowerShell 环境检查在依赖存在和缺失时返回稳定退出码。
- DOCX 样例通过 OpenXML/XSD/业务规则检查。
- 若 LibreOffice 可用，渲染包含中文、表格、页眉页脚和分页的样例并检查页面图像。

## 子项目四：PPTX Windows 收口

PptxGenJS 主生成方式保留，只调整外围约定：

- 临时目录改用跨平台创建方式，不写死 `/tmp`。
- 不要求全局安装 PptxGenJS，优先使用 Cyrene 项目依赖或明确的本地依赖路径。
- 将 PPTX 主题键映射到共享设计令牌。
- 增加 Windows 友好的生成和结构验证命令。
- 视觉渲染后端可选使用本机 PowerPoint 或 LibreOffice；没有渲染器时仍执行 OOXML 结构和溢出风险检查。

## 兼容与迁移

- 保留旧内容 JSON 和现有文档类型名称。
- 旧 `make.sh` 调用在过渡期继续工作，但只转发给 `make.py`。
- `render_cover.js` 在新的 PDF 样例和测试全部通过后删除。
- 不修改用户已有 DOCX/XLSX/PPTX 文件的默认编辑语义。
- 共享主题缺失或无效时，各格式继续使用当前默认主题，避免升级后无法生成文件。

## 错误处理

- 所有 Python 和 PowerShell 入口使用非零退出码表示失败。
- 缺少必需依赖时输出可执行的 Windows 安装提示，不自动修改系统环境。
- 缺少可选视觉渲染器时，结构验证仍可继续，但最终报告必须说明未完成视觉复检。
- 字体缺失时按候选链回退，并在生成报告中记录实际字体。
- 输出文件先写入临时路径，验证通过后再移动到目标路径，避免留下半成品。

## 测试策略

每个子项目独立使用测试驱动开发：

1. 先写失败测试，证明 Windows 路径、字体、命令或渲染能力尚未满足。
2. 实现最小修改使测试通过。
3. 运行该技能的脚本测试和 Cyrene 现有 Vitest 回归测试。
4. 使用真实 DOCX/XLSX/PDF/PPTX 样例进行产物级验证。
5. 对技能目录运行 `quick_validate.py`，检查 Skill frontmatter 和资源引用。

测试文件放在各技能自己的 `tests/` 目录；跨技能主题验证放在 `skills/office-design/tests/`。

## 分阶段交付

1. 共享设计令牌和校验器。
2. PDF 纯 Python 渲染流水线。
3. XLSX 跨平台工作流和 Windows 文档。
4. DOCX PowerShell 环境检查及预览。
5. PPTX 临时目录、依赖解析和主题映射收口。
6. 全量技能校验、产物验证和打包检查。

每个阶段均应产生可独立运行、可回退的提交；后续阶段不得以破坏前一阶段兼容性为代价。

## 验收标准

- 在 Windows PowerShell 中，四种格式的主流程不调用 Bash、WSL、GNU grep 或 `/tmp`。
- PDF 主流程不加载 Playwright、Edge 或 Chromium。
- 应用级 Playwright MCP 仍可按用户设置独立启用。
- 现有 MiniMax 文档类型和样式预设仍可选择。
- 中文文本在四种格式中使用明确字体回退，不出现空白方框或丢字。
- 每种格式至少有一个真实样例通过结构验证；视觉敏感格式有渲染复检结果。
- 新增和修改的脚本测试通过，Cyrene 现有相关测试无回归。
