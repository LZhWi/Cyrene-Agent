# HUD 原生圆角模糊实验

运行：在 `local-plugins` 执行 `node scripts/hud-composition-probe/run.mjs`。仅支持本机 Windows 实验环境，需要已有 Electron 依赖以及系统自带 .NET Framework C# 编译器和 WinMetadata。没有安装额外 SDK，也没有改动正式 HUD 插件或 ZIP。

原生辅助窗口使用 Windows.UI.Composition 的 HostBackdropBrush、RoundedRectangleGeometry 和 GeometricClip；Electron 透明窗口在上层绘制现有 HUD。原生背景画刷由系统合成器处理，没有持续截图回传渲染，也不连接模型。截图仅用于此测试的对比断言。原型使用独立条纹背景窗口和固定时间预设，不读取真实聊天或模型数据。

2026-10-08，Windows 11 本机、150% 显示缩放的结果：

- 直角、60 px 圆角和胶囊形已目视检查；圆角外采样区域与背景的像素差为 0。
- 条纹背景的水平变化由 5.5098 降为 0.0168，确认实际模糊而不是单纯染色。
- 粉色条纹变为蓝色条纹后，模糊层正常更新。
- Electron 文字置于模糊层上方，深色文字像素与截图确认文字保持清晰。
- 粉色、蓝色、深色的独立半透明颜色层已测试；深色预设的次要文字对比度尚未适配，不应直接作为成品主题。
- 600×200 到 400×140 的尺寸变化、同屏移动及正常退出已验证。
- **启动焦点检查未通过。** 早期部分运行没有焦点异常，重复测试后发现辅助窗口会成为前台窗口；`result.json` 如实保持 `ok: false`，不能将视觉检查通过等同于完整集成通过。

最新证据位于 `.test-runtime/hud-composition-1791442176113`。鼠标实际穿透、跨屏混合 DPI、系统关闭透明效果时的降级和宿主插件生命周期集成尚未验证。该目录仅为可行性原型，不随插件打包。

接口依据：[HostBackdropBrush](https://learn.microsoft.com/en-us/uwp/api/windows.ui.composition.compositor.createhostbackdropbrush)、[CompositionGeometricClip](https://learn.microsoft.com/en-us/uwp/api/windows.ui.composition.compositiongeometricclip)。
