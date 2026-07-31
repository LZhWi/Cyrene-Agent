# React Electron 预览窗口设计

## 目标

在 React Chat 迁移期间，开发启动时额外显示一个 Electron 窗口加载现有 `/react/` 页面，用于调试无边框窗口、圆角、拖拽区和窗口控件。现有原生 Chat 窗口继续正常创建，直到 React 功能迁移完成后再单独安排替换与删除。

## 方案

复用项目现有的 Electron `BrowserWindow`、Vite 开发服务器和 preload，不引入新依赖，也不实现新的预览容器。

- 新增一个独立的 React 预览窗口引用和创建函数。
- 窗口仅在 `VITE_DEV=1` 时创建，并自动加载 `http://localhost:5173/react/`。
- React 预览窗口与当前 Chat 使用相同的基础窗口尺寸、最小尺寸、无边框设置、透明背景和 preload。
- 现有 `createChatWindow()`、`/chat/` 页面、会话切换和正式打包加载路径保持不变。
- 关闭 React 预览窗口只清理自身引用，不影响原 Chat、桌宠或应用生命周期。

## 启动与数据流

1. `npm run dev` 启动 Vite 和带有 `VITE_DEV=1` 的 Electron。
2. Electron 继续创建桌宠窗口和原 Chat 窗口。
3. 主进程额外创建 React 预览窗口。
4. React 预览窗口通过 Vite 加载 `/react/`，并使用现有 preload 获得受控的 Electron bridge。
5. 正式启动或打包运行时不创建该预览窗口。

## 错误与生命周期

- 预览窗口已存在时，重复调用创建函数只显示并聚焦现有窗口。
- 窗口等待 `ready-to-show` 后显示，避免加载过程闪烁。
- 窗口关闭后将引用设为空，保证后续开发调试可以重新创建。
- Vite 页面加载失败时沿用 Electron 的加载失败日志，不改变其他窗口状态。

## 验证

- 先增加一个失败测试，约束预览窗口只在开发态自动创建，防止正式构建误开预览窗。
- 运行主进程 TypeScript 构建和相关 Vitest 测试。
- 实际运行开发环境，确认旧 Chat 与 React 预览窗口同时出现，React 窗口地址为 `/react/`，关闭其中任一窗口不影响另一个窗口。

## 不在本次范围内

- 不删除或替换原 Chat。
- 不迁移聊天业务逻辑、会话状态或 IPC 行为。
- 不为正式安装包增加 React 预览入口。
- 不改变当前 React 页面视觉设计。
