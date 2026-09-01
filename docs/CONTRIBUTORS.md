# 贡献者

感谢所有通过 GitHub 为项目做出贡献的开发者！以下是贡献者列表（按首次贡献时间排序）。

---

## 代码贡献

### lll69
- 设置面板改进：`max_token` 开关、`thinkingOverride`、`uiThemeRadius`、GPU 渲染开关等
- 超时配置体系：为 chat-loop、搜索等功能添加可配置超时，优化首轮响应
- 搜索引擎集成：AnySearch 适配
- 设置缓存机制与 UI 优化，移除不必要的 API Key 校验

### Unknownuserfrommars
- 修复截图辅助进程先退出时主进程崩溃的问题

### Tobi1chi ([Tobi1chi](https://github.com/Tobi1chi))
- NapCat OneBot 频道适配器支持（PR #40）

### Wang Xiaomei ([Asuna404-not-found](https://github.com/Asuna404-not-found))
- 修复构建编译过程中的 Bug（PR #33，参考其修法自行合并）

### boring9720 ([boring9720](https://github.com/boring9720))
- 主进程日志落盘 `userData/logs/cyrene.log`（滚动 3 份 × 5MB），打包版用户可直接附日志上报问题（PR #47）

### 梨衣、 ([liyi3068238601-oss](https://github.com/liyi3068238601-oss))
- 运行时插件系统 v1：清单校验、生命周期状态机、资源所有权隔离与串行队列（PR #42/#48）
- 插件 ZIP 安全导入与原子安装：staging 隔离解压、路径穿越/ZIP 炸弹防护、失败自动回滚
- 用户插件安全卸载，插件设置页与启停管理

---

## 特别鸣谢

- **是依七哒** — 制作并分享 Live2D 模型相关资源，为桌宠展示提供了重要参考与支持

---

*因社区贡献持续增长，列表可能未完全覆盖，如有遗漏敬请谅解。*