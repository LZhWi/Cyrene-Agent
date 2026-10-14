# 来源

采集器派生自 Playa 的 Cyrene-Plugins `plugins/system-status/index.cjs`（MIT）。

- 上游：https://github.com/Playa-Cyrene/Cyrene-Plugins/tree/main/plugins/system-status
- 读取日期：2026-10-08
- 读取的上游 index.cjs SHA-256：acd319d1cc6db925dce70761fef354a9b7a9bd9e36fbceaccae23b4ec5e15719
- 原版权和 MIT 许可完整保留在 LICENSE。

本地改动：采集器内置于 cyrene-hud，仅通过该插件自身的 snapshot IPC 为 HUD 提供数据，不再依赖独立 system-status 插件。移除上游全部 AI 工具和原窗口；修正网络累计值的取法；共享 2.5 秒缓存和进行中的采集；停用时中止子进程并拒绝迟到结果；NVIDIA 固定读取 GPU 0，失败后 30 秒重试；区分接通电源和充电，缺失值保留为空。

HUD 的 HTML/CSS 为本地新实现，没有复制 zmd-charge-plus 的代码或素材。

0.2.1 的配色与字体栈对齐本项目 `src/renderer/react/styles/react-root.css`、`src/renderer/ui/theme.css` 和 `src/renderer/ui/tokens.css`。`avatar.svg` 复用本项目 `src/renderer/public/icons/cyrene-avatar-line.svg`，保持原样。
