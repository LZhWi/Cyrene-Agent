---
name: pdf

description: >
  当 PDF 的视觉质量和设计感很重要时，使用此 skill。 CREATE（从零生成）："制作一个 PDF"、"生成一份报告"、"写一份建议书"、
  "创建一份简历"、"精美的 PDF"、"专业文档"、"封面"、 "精致的 PDF"、"客户就绪文档"。 FILL（填写表单域）："填写表单"、"填写这个
  PDF"、 "完成表单字段"、"将值写入 PDF"、"这个 PDF 有哪些字段"。
  REFORMAT（对已有文档应用设计）："重新格式化此文档"、"应用我们的风格"、 "将此 Markdown/文本转换为
  PDF"、"让这个文档看起来好看"、"重新设计此 PDF 的样式"。 此 skill 使用基于 token
  的设计系统：颜色、排版和间距根据文档类型派生并贯穿每一页。输出为打印就绪格式。 优先使用此 skill 当外观很重要时，而不仅仅是需要 PDF 输出时。
license: MIT
metadata:
  version: '1.0'
  category: document-generation
modes:
  - work
  - learn
---

# minimax-pdf

三项任务，一个 skill。

## 在执行任何 CREATE 或 REFORMAT 工作之前，必须阅读 `design/design.md`

---

## 路由表

| 用户意图 | 路由 | 使用的脚本 |
|---|---|---|
| 从零生成一个新 PDF | **CREATE** | `palette.py` → `cover.py` → `render_cover.js` → `render_body.py` → `merge.py` |
| 填写/完成已有 PDF 中的表单字段 | **FILL** | `fill_inspect.py` → `fill_write.py` |
| 重新格式化/重新设计已有文档 | **REFORMAT** | `reformat_parse.py` → 完整的 CREATE 管道 |

**规则：** 当在 CREATE 和 REFORMAT 之间犹豫时，询问用户是否已有文档作为起点。如有 → REFORMAT。如无 → CREATE。

---

## 路由 A: CREATE

完整管道 — 内容 → 设计 token → 封面 → 正文 → 合并 PDF。

```bash
bash scripts/make.sh run \
  --title "Q3 策略评审" --type proposal \
  --author "策略团队" --date "2025 年 10 月" \
  --accent "#2D5F8A" \
  --content content.json --out report.pdf
```

**文档类型：** `report` · `proposal` · `resume` · `portfolio` · `academic` · `general` · `minimal` · `stripe` · `diagonal` · `frame` · `editorial` · `magazine` · `darkroom` · `terminal` · `poster`

| 类型 | 封面模式 | 视觉标识 |
|---|---|---|
| `report` | `fullbleed` | 深色背景，点阵网格，Playfair Display |
| `proposal` | `split` | 左侧面板 + 右侧几何，Syne |
| `resume` | `typographic` | 超大首词，DM Serif Display |
| `portfolio` | `atmospheric` | 近黑色，径向发光，Fraunces |
| `academic` | `typographic` | 浅色背景，经典衬线体，EB Garamond |
| `general` | `fullbleed` | 深灰蓝，Outfit |
| `minimal` | `minimal` | 白色 + 单条 8px 强调线，Cormorant Garamond |
| `stripe` | `stripe` | 3 条粗水平色带，Barlow Condensed |
| `diagonal` | `diagonal` | SVG 斜切，深/浅两半，Montserrat |
| `frame` | `frame` | 内嵌边框，角饰，Cormorant |
| `editorial` | `editorial` | 幽灵字母，全大写标题，Bebas Neue |
| `magazine` | `magazine` | 暖米色背景，居中堆叠，主图，Playfair Display |
| `darkroom` | `darkroom` | 深蓝背景，居中堆叠，灰度图像，Playfair Display |
| `terminal` | `terminal` | 近黑色，网格线，等宽字体，霓虹绿 |
| `poster` | `poster` | 白色背景，粗侧边栏，超大标题，Barlow Condensed |

封面附加项（通过 `--abstract`、`--cover-image` 注入 token）：
- `--abstract "文本"` — 封面上的摘要文本块（magazine/darkroom）
- `--cover-image "url"` — 主图 URL/路径（magazine、darkroom、poster）

**颜色覆盖 — 始终根据文档内容选择：**
- `--accent "#HEX"` — 覆盖强调色；`accent_lt` 自动通过向白色淡化派生
- `--cover-bg "#HEX"` — 覆盖封面背景色

**强调色选择指南：**

你对强调色拥有创作权。从文档的语义上下文——标题、行业、目的、受众——中选取，而非选择通用的"安全"色。强调色出现在节间分隔线、标注栏、表头以及封面上：它承载着文档的视觉标识。

| 上下文 | 建议强调色范围 |
|---|---|
| 法律/合规/金融 | 深海军蓝 `#1C3A5E`，炭灰 `#2E3440`，石板灰 `#3D4C5E` |
| 医疗/健康 | 青绿色 `#2A6B5A`，冷绿 `#3A7D6A` |
| 技术/工程 | 钢蓝 `#2D5F8A`，靛蓝 `#3D4F8A` |
| 环境/可持续 | 森林绿 `#2E5E3A`，橄榄绿 `#4A5E2A` |
| 创意/艺术/文化 | 勃艮第红 `#6B2A35`，梅紫 `#5A2A6B`，陶土色 `#8A3A2A` |
| 学术/研究 | 深青 `#2A5A6B`，图书馆蓝 `#2A4A6B` |
| 企业/中性 | 石板灰 `#3D4A5A`，石墨灰 `#444C56` |
| 奢侈/高级 | 暖黑 `#1A1208`，古铜 `#4A3820` |

**规则：** 选择一位有品味的设计师会为这份特定文档选择的颜色——而不是类型的默认色。柔和、低饱和度的色调效果最好；避免鲜艳的原色。犹豫不决时，选择更暗、更中性的颜色。

**content.json 块类型：**

| 块类型 | 用途 | 关键字段 |
|---|---|---|
| `h1` | 章节标题 + 强调分隔线 | `text` |
| `h2` | 子章节标题 | `text` |
| `h3` | 子子章节（粗体） | `text` |
| `body` | 两端对齐段落；支持 `<b>` `<i>` 标记 | `text` |
| `bullet` | 无序列表项（• 前缀） | `text` |
| `numbered` | 有序列表项 — 计数器在遇到非编号块时自动重置 | `text` |
| `callout` | 带强调左侧色条的高亮见解框 | `text` |
| `table` | 数据表格 — 强调色表头，交替行底色 | `headers`, `rows`, `col_widths`?, `caption`? |
| `image` | 缩放至列宽的嵌入式图片 | `path`/`src`, `caption`? |
| `figure` | 带自动编号 "图 N:" 的图片 | `path`/`src`, `caption`? |
| `code` | 带强调色左边框的等宽代码块 | `text`, `language`? |
| `math` | 显示数学公式 — LaTeX 语法，通过 matplotlib mathtext 渲染 | `text`, `label`?, `caption`? |
| `chart` | 使用 matplotlib 渲染的柱/折/饼图 | `chart_type`, `labels`, `datasets`, `title`?, `x_label`?, `y_label`?, `caption`?, `figure`? |
| `flowchart` | 使用 matplotlib 绘制的流程节点 + 连线图 | `nodes`, `edges`, `caption`?, `figure`? |
| `bibliography` | 带悬挂缩进的编号参考文献列表 | `items` [{id, text}], `title`? |
| `divider` | 强调色全宽分隔线 | — |
| `caption` | 小型弱化标签 | `text` |
| `pagebreak` | 强制分页 | — |
| `spacer` | 垂直空白 | `pt`（默认 12） |

**chart / flowchart 模式：**
```json
{"type":"chart","chart_type":"bar","labels":["Q1","Q2","Q3","Q4"],
 "datasets":[{"label":"Revenue","values":[120,145,132,178]}],"caption":"Q results"}

{"type":"flowchart",
 "nodes":[{"id":"s","label":"Start","shape":"oval"},
          {"id":"p","label":"Process","shape":"rect"},
          {"id":"d","label":"Valid?","shape":"diamond"},
          {"id":"e","label":"End","shape":"oval"}],
 "edges":[{"from":"s","to":"p"},{"from":"p","to":"d"},
          {"from":"d","to":"e","label":"Yes"},{"from":"d","to":"p","label":"No"}]}

{"type":"bibliography","items":[
  {"id":"1","text":"Author (Year). Title. Publisher."}]}
```

---

## 路由 B: FILL

填写已有 PDF 中的表单字段，不改变布局或设计。

```bash
# Step 1: inspect
python3 scripts/fill_inspect.py --input form.pdf

# Step 2: fill
python3 scripts/fill_write.py --input form.pdf --out filled.pdf \
  --values '{"FirstName": "Jane", "Agree": "true", "Country": "US"}'
```

| 字段类型 | 值格式 |
|---|---|
| `text` | 任意字符串 |
| `checkbox` | `"true"` 或 `"false"` |
| `dropdown` | 必须匹配 inspect 输出中的某个选项值 |
| `radio` | 必须匹配某个 radio 值（通常以 `/` 开头） |

始终先运行 `fill_inspect.py` 以获取精确的字段名称。

---

## 路由 C: REFORMAT

解析已有文档 → content.json → CREATE 管道。

```bash
bash scripts/make.sh reformat \
  --input source.md --title "我的报告" --type report --out output.pdf
```

**支持的输入格式：** `.md` `.txt` `.pdf` `.json`

---

## 环境

```bash
bash scripts/make.sh check   # 验证所有依赖
bash scripts/make.sh fix     # 自动安装缺失的依赖
bash scripts/make.sh demo    # 构建示例 PDF
```

| 工具 | 使用者 | 安装方式 |
|---|---|---|
| Python 3.9+ | 所有 `.py` 脚本 | 系统 |
| `reportlab` | `render_body.py` | `pip install reportlab` |
| `pypdf` | fill，merge，reformat | `pip install pypdf` |
| Node.js 18+ | `render_cover.js` | 系统；打包版自动回落 Cyrene 内置 Node，无需安装 |
| `playwright` | `render_cover.js` | 打包版随应用内置；开发环境 `npm install -g playwright`。浏览器优先系统 Edge，无需下载 Chromium |
