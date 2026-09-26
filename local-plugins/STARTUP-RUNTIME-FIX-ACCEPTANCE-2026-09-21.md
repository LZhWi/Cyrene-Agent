# N 启动与退出问题修复验收（2026-09-21）

## 问题

1. 隔离 `USERPROFILE` 缺少 `Desktop`，Windows 文件选择器弹出“位置不可用”。
2. 开发树缺少 `cyrene-screenshot.exe`，截图服务预热报 `ENOENT`。
3. 退出时窗口销毁与 IPC 注销并行，渲染器最后一次光标查询可能遇到 `No handler registered`。

## 修复

- 隔离启动器在 N 自有 `AppData/Profile` 下创建 Desktop、Documents、Downloads、Pictures、Music、Videos。
- `shell-ipc` 延后到 `flushPersistence` 阶段注销，确保 `window-manager` 已在前一阶段停止。
- 从上游官方 v1.2.2 Release 安装包提取截图 helper；安装包 SHA-512 与官方 `latest.yml` 一致。
- helper SHA-256：`07515F2060084DBDEF3A54E4A573AD5A4E49D4C21B2F786018376F2E554306BC`。
- helper 放入开发运行路径及打包资源路径；临时安装包、解包目录和解包工具均已删除。

## 验证

- `npm run build:main`：通过。
- Shell 与截图相关测试：5 个测试文件、34 项测试全部通过。
- helper 静态 PE 校验：通过，文件大小 651776 字节。
- helper 协议实测：`ready(protocolVersion=1) → shutdown → exitCode=0`。
- 正式 N 隔离启动：截图后台预热在 110 ms 完成，不再出现 `ENOENT`。
- 当前显示缩放使 DXGI 尺寸与逻辑主屏尺寸不同，helper 按上游设计自动回退到 GDI；服务仍正常可用。
- 隔离 Profile 的六个 Windows 已知目录均存在。
- Shell 退出顺序回归测试确认 `window-manager` 先停止、IPC 后注销。

本修复没有修改原 Cyrene 用户数据；仅在最终聊天对账时只读访问。所有持久写入均位于 `Cyrene-Agent-N`。
