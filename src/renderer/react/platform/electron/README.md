# Platform / Electron

Electron IPC 接口的类型定义和适配层。

## 原则

- 本阶段不接入真实 IPC
- 只定义接口类型，后续由 Codex 接线
- 组件不得直接访问 `window.chat`、`window.agui` 等全局对象
- 所有外部行为通过 Props / Callback / Adapter 暴露
