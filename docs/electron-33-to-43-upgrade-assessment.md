# Electron 33 → 43 升级评估报告

> 评估日期：2026-07-08
> 当前版本：Electron 33
> 目标版本：Electron 43

## 版本信息

| 组件 | Electron 33 (当前) | Electron 43 (目标) |
|------|-------------------|-------------------|
| **Chromium** | 130.x | 138.x |
| **Node.js** | 20.x | 22.x |
| **V8** | ~12.8 | ~13.x |

---

## 风险评估总览

| 领域 | 风险等级 | 说明 |
|------|---------|------|
| BrowserWindow / transparent / alwaysOnTop | 🟡 中 | DWM 变化可能影响透明窗口 |
| preload / contextBridge / IPC | 🟢 低 | API 基本稳定 |
| file:// / dist 资源路径 | 🟢 低 | 路径解析稳定 |
| WebGL / Pixi.js / Live2D | 🔴 高 | Chromium WebGL 变化 |
| Tray / safeStorage / shell.openExternal | 🟢 低 | API 稳定 |
| Native 模块 (nut.js, jieba, sharp) | 🔴 高 | 需要重新编译 |
| electron-builder 打包 | 🟡 中 | 配置语法可能需调整 |

---

## 1. BrowserWindow / transparent / alwaysOnTop

**风险等级：🟡 中**

### 当前实现
```typescript
mainWindow = new BrowserWindow({
  width: PET_WINDOW_BASE_WIDTH,
  height: PET_WINDOW_BASE_HEIGHT,
  transparent: true,
  frame: false,
  skipTaskbar: true,
  resizable: false,
  hasShadow: false,
  webPreferences: { sandbox: false },
});
mainWindow.setIgnoreMouseEvents(true, { forward: true });
```

### 变化影响
- **Electron 38+ (Chromium M136+)**：DWM (Desktop Window Manager) 层叠变化
- 透明窗口的 alpha 通道处理可能不同
- `setIgnoreMouseEvents` API 未变，但底层行为可能受影响

### 需测试
- [ ] 透明窗口渲染是否正常
- [ ] 鼠标穿透控制器 (`src/renderer/live2d/click-through.ts`) alpha 采样是否正常
- [ ] `opacity: 0.99` workaround 是否仍需要

### 行动项
- 检查 `pixi-live2d-display` 是否需要更新以支持新版 Chromium
- 验证 `preserveDrawingBuffer` 仍正常工作

---

## 2. preload / contextBridge / IPC

**风险等级：🟢 低**

### 当前实现
```typescript
// src/preload/index.ts
import { contextBridge, ipcRenderer, webUtils } from "electron";
contextBridge.exposeInMainWorld("cyrene", cyreneApi);
```

### 变化影响
- **Electron 34+**：`contextBridge` API 稳定
- **Electron 35+**：`@electron/get` 升级，影响 CI 下载但不影响运行时
- **Electron 38+**：`ElectronPermission` 类型变化

### 需测试
- [ ] 所有 IPC 通道通信正常
- [ ] TypeScript 类型无报错

### 行动项
- 更新 `@types/node` 从 `^20.9.0` 到 `^24.9.0`

---

## 3. file:// / dist 资源路径

**风险等级：🟢 低**

### 当前实现
```typescript
if (isDev) {
  mainWindow.loadURL("http://localhost:5173");
} else {
  mainWindow.loadFile(path.join(__dirname, "..", "..", "renderer", "index.html"));
}
```

### 变化影响
- `loadFile()` / `loadURL()` API 无变化
- Vite 构建配置不变

### 行动项
- 重建后验证资源路径

---

## 4. WebGL / Pixi.js / Live2D

**风险等级：🔴 高**

### 当前实现
```typescript
this.app = new PIXI.Application({
  view: canvas,
  transparent: true,
  preserveDrawingBuffer: true,
  // ...
});
```

### 变化影响
| 依赖包 | 当前版本 | 兼容性风险 |
|--------|---------|-----------|
| pixi.js | 7.3.0 | 🟢 低 - v7 系列支持 Chromium 130-138 |
| pixi-live2d-display | 0.5.0-beta | 🟡 中 - beta 版本需确认 |

- **Chromium 130 → 138**：WebGL/WebGPU 变化
- **Electron 40+**：GPU 进程隔离变化
- **Electron 43**：WebGL robust buffer access 改进

### 需测试
- [ ] WebGL 渲染透明度
- [ ] Live2D 模型加载
- [ ] `preserveDrawingBuffer` 正常工作
- [ ] Alpha 通道混合效果

### 行动项
1. 测试 WebGL 渲染
2. 检查 `pixi-live2d-display` 是否有支持新版 Chromium 的更新
3. 验证 `preserveDrawingBuffer` 行为

---

## 5. Tray / safeStorage / shell.openExternal

**风险等级：🟢 低**

### 变化影响
- **Electron 34+**：`shell.openExternal` 行为未变
- **Electron 38+**：安全改进但无 API 变化

### 需测试
- [ ] 托盘图标显示正常
- [ ] 右键菜单正常

---

## 6. Native 模块

**风险等级：🔴 高**

### 项目中的 Native 模块

| 模块 | 用途 | 需重建 | 兼容性 |
|------|------|--------|--------|
| `@nut-tree-fork/nut-js` | 屏幕自动化 | ✅ | 检查 v4.2.6+ 对 Node 22 的支持 |
| `@node-rs/jieba` | 中文分词 | ✅ | 确认 Node 22 预编译二进制 |
| `sharp` | 图片处理 | ✅ | 确认 Node 22 + Electron 43 的预编译二进制 |
| `tree-sitter` | 解析器 | ✅ | 需重建 |

### 当前 allowScripts 配置
```json
"allowScripts": {
  "protobufjs@7.6.4": true,
  "protobufjs@6.11.6": true,
  "electron@33.4.11": true,
  "esbuild@0.21.5": true,
  "sharp@0.32.6": true,
  "tree-sitter@0.22.4": true
}
```

### 行动项
1. 更新 `allowScripts` 包含新 Electron 版本
2. 运行 `npm rebuild`
3. 或使用 `electron-rebuild`

---

## 7. electron-builder 打包

**风险等级：🟡 中**

### 当前状态
- 项目未使用 electron-builder

### 如需使用
- 更新到最新版本 (^25.x) 以支持 Electron 43
- 检查配置语法变化
- 使用 `afterPack` hooks 处理 native 模块

---

## 8. Native ABI / electron-rebuild 风险

**风险等级：🔴 高**

Electron 升级后，所有 Native 模块必须重新编译 ABI。

### 需要验证的 Native 模块

| 模块 | 用途 | 关键检查项 |
|------|------|-----------|
| `@node-rs/jieba` | 中文分词 | 是否有 Electron 43 / Node 22 的预编译二进制？是否需要 `electron-rebuild`？ |
| `@nut-tree-fork/nut-js` | 屏幕自动化 | `libnut-win32` 是否兼容 Electron 43？是否需要手动重建？ |
| `sharp` | 图片处理 | 是否有 Node 22 + Electron 43 的预编译二进制？ |
| `tree-sitter` | 解析器 | 预编译二进制是否覆盖新平台？ |

### 风险说明

1. **Node.js ABI 变化**：Electron 33 内置 Node 20.x，Electron 43 内置 Node 22.x
   - 所有预编译的 native addon 需要针对 Node 22 重新编译
   - 如无预编译二进制，`npm rebuild` 或 `electron-rebuild` 是必需步骤

2. **Electron ABI 变化**：Electron 每个版本都有自己的 ABI
   - 即使 Node.js 版本相同，Electron 版本不同也需要重建
   - `electron-rebuild` 可以处理这个场景

3. **预编译 vs 源码编译**：
   - 如果模块有 Electron 43 预编译 → `npm install` 直接可用
   - 如果无预编译 → 需要 `electron-rebuild` 从源码编译

### 建议行动

1. **升级前**：先查各模块的 Release Notes / Issues，确认是否已有 Electron 43 支持
2. **升级后**：`npm rebuild` 优先，如果失败再用 `electron-rebuild`
3. **备用方案**：如果 native 模块重建失败，考虑降级方案

### 检查命令

```bash
# 检查 sharp 预编译
npm info sharp

# 检查 jieba 预编译
npm info @node-rs/jieba

# 如果需要重建
npm rebuild
# 或
npx electron-rebuild
```

---

## 9. 升级路径建议

### 主路线（直接试升级）

```
Electron 33 → Electron 43
```

**原因**：
1. 最终目标就是 Electron 43，中间版本不作为长期停留目标
2. 逐段升级会消耗大量测试时间
3. 直接升级失败后再回退定位，而不是一开始就逐段爬版本

### 失败后定位路线

```
Electron 43 失败 → 试 Electron 40
Electron 40 失败 → 试 Electron 38
Electron 38 正常 / Electron 40 失败 → 重点排查 38 → 40 之间的 breaking changes
```

### 直接升级步骤 (不执行，仅记录)

```bash
# 1. 更新 devDependencies
npm install electron@43.0.0 --save-dev

# 2. 重建 native 模块
npm rebuild
# 或
npx electron-rebuild

# 3. 验证构建
npm run build

# 4. 运行测试
npm test

# 5. 手动测试 (见下方清单)
npm start
```

### 测试清单

| 测试项 | 检查点 |
|--------|--------|
| 🪟 桌宠透明窗口 | WebGL 渲染、DWM 层叠 |
| 🖼️ Live2D 加载 | 模型动画、表情切换 |
| 💬 聊天窗口 | IPC 通信、消息收发 |
| ⚙️ 设置窗口 | 配置保存、IPC |
| 🖼️ 贴纸 | 资源加载、相似度匹配 |
| 📡 preload IPC | 所有通道通信正常 |
| 🖥️ 托盘 | 图标、右键菜单 |
| 🪟 多窗口 | 打开/关闭、状态同步 |
| 📁 文件路径 | `file://` / `dist` 资源 |
| 🤖 RAG 模型缺失降级 | 警告日志、功能关闭 |

---

## 10. 总结

### 总体风险：🟡 中-🔴 高

### 可行性评估
- ✅ 升级本身可行
- ⚠️ Native 模块需要重建
- ⚠️ WebGL/透明窗口需要测试
- ⚠️ pixi-live2d-display beta 版本需确认兼容性

### 建议
1. **主路线直接升级到 Electron 43**
2. 如果失败，再回退到 40/38/35 做定位
3. 重点测试透明窗口 + 鼠标穿透控制器
4. 验证 native 模块重建成功

### 下一步
- 当前分支 `chore/electron-upgrade` 已完成 Electron 43 试升级
- `npm install` / `npm ci` 已通过
- `npm run build` 已通过
- `npm test` 已通过（350 tests / 52 files）
- 仍需完成 GUI 手动测试清单（透明窗口、Live2D、IPC、托盘等）
- GUI 测试通过后再提交并 push
