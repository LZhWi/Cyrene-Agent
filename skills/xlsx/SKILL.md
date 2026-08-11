---
name: xlsx

description: >-
  打开、创建、读取、分析、编辑或验证
  Excel/电子表格文件（.xlsx、.xlsm、.csv、.tsv）。当用户要求创建、构建、修改、分析、读取、验证或格式化任何 Excel
  电子表格、财务模型、数据透视表或表格数据文件时使用。涵盖：从零创建新的 xlsx、读取和分析已有文件、零格式丢失地编辑已有
  xlsx、公式重算与验证，以及应用专业财务格式化标准。触发词：'spreadsheet'、'Excel'、'.xlsx'、'.csv'、'pivot
  table'、'financial model'、'formula'，或任何要求以 Excel 格式输出表格数据的请求。
license: MIT
metadata:
  version: '1.0'
  category: productivity
  sources:
    - ECMA-376 Office Open XML File Formats
    - Microsoft Open XML SDK documentation
modes:
  - work
  - learn
---

# MiniMax XLSX Skill

直接处理请求。**禁止**生成子 agent。始终将输出文件写入用户请求的路径。

## ⚠️ 先判断：是否需要本 Skill

在开始任何操作前，先判断任务复杂度：

- **简单表格生成**（数据整理、换算导出、清单列表）→ **直接用 `write_excel` 工具**，不要继续读本 Skill。
  `write_excel` 已内置美观样式（表头加粗、边框、斑马纹、列宽自适应、冻结首行）和支持自定义颜色。

  如果用户要求"美观""好看"等模糊风格，先读 `styles/catalog.md`（样式目录），
  从中选 2-4 个风格作为选项，用 `ask_user_choice` 弹卡片让用户选择。
  **第一个选项固定是 `default`（默认深蓝）**，后面由你根据任务场景自选。
  用户选完后将风格名传给 `write_excel` 的 `style` 参数即可。
  用户也可以在卡片里自定义输入，你把颜色描述翻译成 ARGB hex 传给 `colors` 参数。

- **需要以下任一才继续本 Skill**：
  - Excel 公式（`SUM`、`VLOOKUP`、跨表引用等）
  - 编辑已有 xlsx 文件（保留原有格式/宏/透视表）
  - 财务格式化标准（蓝/黑/绿颜色编码）
  - 公式验证与重算

## 脚本路径

本 Skill 的脚本在 `SKILL_DIR/scripts/` 下，模板在 `SKILL_DIR/templates/` 下。
`SKILL_DIR` 的实际路径在 invoke_skill 返回的清单中已标注，或可通过以下命令快速定位：
```bash
python3 -c "import os,glob; print([p for p in glob.glob(os.path.expanduser('~/Desktop/**/xlsx_pack.py'),recursive=True)][:1])"
```
**不要**花多轮搜索路径——拿到路径后立即开始执行。

## 任务路由

| 任务 | 方法 | 指南 |
|------|--------|-------|
| **READ** — 分析已有数据 | `xlsx_reader.py` + pandas | `references/read-analyze.md` |
| **CREATE** — 从零创建新 xlsx | XML 模板 | `references/create.md` + `references/format.md` |
| **EDIT** — 修改已有 xlsx | XML 解包→编辑→打包 | `references/edit.md`（如需样式参见 `format.md`） |
| **FIX** — 修复已有 xlsx 中损坏的公式 | XML 解包→修复 `<f>` 节点→打包 | `references/fix.md` |
| **VALIDATE** — 检查公式 | `formula_check.py` | `references/validate.md` |

### 执行纪律（必须遵守）

1. **只读完成任务所需的最少 reference**——读完能执行就立即开始，不要把所有文档都读一遍。
2. **同一 reference 文件不要重复读取**（系统会拦截重复读取）。
3. **不要用 list_dir 遍历 templates/scripts 目录**——路径上文已给出，直接用。
4. **信息足够后立即执行**——不要继续研究格式文档。
5. **若预计轮数紧张，优先输出可交付版本**而非继续优化格式。

## READ — 分析数据（先阅读 `references/read-analyze.md`）

先使用 `xlsx_reader.py` 进行结构发现，然后用 pandas 进行自定义分析。**禁止**修改源文件。

**格式化规则**：当用户指定小数位数（如"保留 2 位小数"）时，将该格式应用于**所有**数值——对每个数字使用 `f'{v:.2f}'`。在要求 `12875.00` 的情况下，**禁止**输出 `12875`。

**聚合规则**：始终直接从 DataFrame 列计算总和/均值/计数——例如 `df['Revenue'].sum()`。**禁止**在聚合前重新派生列值。

## CREATE — XML 模板（阅读 `references/create.md` + `references/format.md`）

复制 `templates/minimal_xlsx/` → 直接编辑 XML → 使用 `xlsx_pack.py` 打包。每个派生值必须为 Excel 公式（`<f>SUM(B2:B9)</f>`），**禁止**硬编码数字。按照 `format.md` 应用字体颜色。

**注意**：仅当需要 Excel 公式时才走此路径。简单数据表格用 `write_excel` 工具即可。

## EDIT — XML 直接编辑（先阅读 `references/edit.md`）

**关键 — 编辑完整性规则：**
1. **禁止为编辑任务创建新的 `Workbook()`。**始终加载原始文件。
2. 输出**必须**包含与输入**相同的工作表**（相同名称、相同数据）。
3. 仅修改任务要求修改的特定单元格——其他所有内容必须保持原样。
4. **保存 output.xlsx 后，必须验证**：使用 `xlsx_reader.py` 或 `pandas` 打开并确认原始工作表名称和原始数据样本仍然存在。如果验证失败，说明你写入了错误的文件——在交付前修复。

**禁止**在已有文件上使用 openpyxl 往返操作（会损坏 VBA、数据透视表、迷你图）。正确做法：解包 → 使用辅助脚本 → 重新打包。

**"填充单元格" / "向已有单元格添加公式" = EDIT 任务。**如果输入文件已存在，并且被告知要填充、更新或向特定单元格添加公式，**必须**使用 XML 编辑路径。**禁止**创建新的 `Workbook()`。示例 — 用跨工作表 SUM 公式填充 B3：
```bash
python3 SKILL_DIR/scripts/xlsx_unpack.py input.xlsx /tmp/xlsx_work/
# 通过 xl/workbook.xml → xl/_rels/workbook.xml.rels 找到目标工作表的 XML
# 然后使用 Edit 工具在目标 <c> 元素内添加 <f>：
#   <c r="B3"><f>SUM('Sales Data'!D2:D13)</f><v></v></c>
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ output.xlsx
```

**添加列**（公式、numfmt、样式自动从相邻列复制）：
```bash
python3 SKILL_DIR/scripts/xlsx_unpack.py input.xlsx /tmp/xlsx_work/
python3 SKILL_DIR/scripts/xlsx_add_column.py /tmp/xlsx_work/ --col G \
    --sheet "Sheet1" --header "% of Total" \
    --formula '=F{row}/$F$10' --formula-rows 2:9 \
    --total-row 10 --total-formula '=SUM(G2:G9)' --numfmt '0.0%' \
    --border-row 10 --border-style medium
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ output.xlsx
```
`--border-row` 标志对该行中的**所有**单元格（不仅仅是新列）应用上边框。当任务要求在合计行使用会计样式边框时使用。

**插入行**（下移已有行、更新 SUM 公式、修复循环引用）：
```bash
python3 SKILL_DIR/scripts/xlsx_unpack.py input.xlsx /tmp/xlsx_work/
# 重要：通过在工作表 XML 中搜索标签文本来找到正确的 --at 行，
# 而不是使用提示中的行号。
# 提示可能写 "row 5 (Office Rent)" 但 Office Rent 实际可能位于第 4 行。
# 始终首先通过文本标签定位行。
python3 SKILL_DIR/scripts/xlsx_insert_row.py /tmp/xlsx_work/ --at 5 \
    --sheet "Budget FY2025" --text A=Utilities \
    --values B=3000 C=3000 D=3500 E=3500 \
    --formula 'F=SUM(B{row}:E{row})' --copy-style-from 4
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ output.xlsx
```
**行查找规则**：当任务说"在行 N（标签）之后"时，始终通过在工作表 XML 中搜索"标签"来找到该行（`grep -n "Label" /tmp/xlsx_work/xl/worksheets/sheet*.xml` 或检查 sharedStrings.xml）。使用实际行号 + 1 作为 `--at`。**禁止**单独调用 `xlsx_shift_rows.py`——`xlsx_insert_row.py` 内部已调用它。

**应用整行边框**（例如在 TOTAL 行上加会计线）：
运行辅助脚本后，对目标行中的**所有**单元格应用边框，而不仅仅是新添加的单元格。在 `xl/styles.xml` 中，追加带有所需样式的新 `<border>`，然后在 `<cellXfs>` 中追加一个新的 `<xf>`，该 `<xf>` 克隆每个单元格的已有 `<xf>` 但设置新的 `borderId`。通过 `s` 属性将新样式索引应用于该行中的每个 `<c>`：
```xml
<!-- 在 xl/styles.xml 中，追加到 <borders>： -->
<border>
  <left/><right/><top style="medium"/><bottom/><diagonal/>
</border>
<!-- 然后在 <cellXfs> 中为每个已有样式追加一个带有新 borderId 的 xf 克隆 -->
```
**关键规则**：当任务说"向第 N 行添加边框"时，遍历 A 列到最后一列的**所有**单元格，而不仅仅是新添加的单元格。

**手动 XML 编辑**（用于辅助脚本无法覆盖的情况）：
```bash
python3 SKILL_DIR/scripts/xlsx_unpack.py input.xlsx /tmp/xlsx_work/
# ... 使用 Edit 工具编辑 XML ...
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/xlsx_work/ output.xlsx
```

## FIX — 修复损坏的公式（先阅读 `references/fix.md`）

这是一个 EDIT 任务。解包 → 修复损坏的 `<f>` 节点 → 打包。保留所有原始工作表和数据。

## VALIDATE — 检查公式（先阅读 `references/validate.md`）

运行 `formula_check.py` 进行静态验证。可用时使用 `libreoffice_recalc.py` 进行动态重算。

## 财务颜色标准

| 单元格角色 | 字体颜色 | Hex 代码 |
|-----------|-----------|----------|
| 硬编码输入/假设 | 蓝色 | `0000FF` |
| 公式/计算结果 | 黑色 | `000000` |
| 跨工作表引用公式 | 绿色 | `00B050` |

## 关键规则

1. **先判断复杂度**：简单表格用 `write_excel`，需要公式/编辑才用本 Skill
2. **公式优先**：每个计算单元格**必须**使用 Excel 公式，**禁止**硬编码数字
3. **CREATE → XML 模板**：复制最小模板，直接编辑 XML，使用 `xlsx_pack.py` 打包
4. **EDIT → XML**：**禁止** openpyxl 往返操作。使用解包/编辑/打包脚本
5. **始终生成输出文件** — 这是最高优先级
6. **交付前验证**：`formula_check.py` 退出码 0 = 安全

## 实用脚本

```bash
python3 SKILL_DIR/scripts/xlsx_reader.py input.xlsx                 # 结构发现
python3 SKILL_DIR/scripts/formula_check.py file.xlsx --json         # 公式验证
python3 SKILL_DIR/scripts/formula_check.py file.xlsx --report      # 标准化报告
python3 SKILL_DIR/scripts/xlsx_unpack.py in.xlsx /tmp/work/         # 解包用于 XML 编辑
python3 SKILL_DIR/scripts/xlsx_pack.py /tmp/work/ out.xlsx          # 编辑后重新打包
python3 SKILL_DIR/scripts/xlsx_shift_rows.py /tmp/work/ insert 5 1  # 下移行以插入
python3 SKILL_DIR/scripts/xlsx_add_column.py /tmp/work/ --col G ... # 添加带公式的列
python3 SKILL_DIR/scripts/xlsx_insert_row.py /tmp/work/ --at 6 ...  # 插入带数据的行
```
