# 插件发布准备验收（2026-09-20）

## 可交付产物

| 插件 | 版本 | 文件数 | ZIP 字节 | SHA-256 |
| --- | --- | ---: | ---: | --- |
| companion-chat | 0.13.0 | 24 | 93459 | `884b352215c73ac2c88b4022d20bfd398151efe7a8a1e6badb8e5f6042a7c078` |
| companion-memory | 0.53.0 | 7 | 106546 | `410c6554a3864322bcefd037f7775124e7a7a10cdad35821e380a69f81e7c1a0` |

本次只把上述两个 ZIP 视为交付物；`plugin-template.zip` 是开发模板，不是本地复刻系统的安装包。

## 包体核验

- 两个 ZIP 均由当前源码重新构建，顶层目录与 manifest id 一致。
- 每个 ZIP 条目都位于自己的插件目录下，不含绝对路径、`..` 路径穿越或额外顶层文件。
- ZIP 内每个文件与对应 `artifacts/<plugin-id>/` 文件逐字节一致。
- 解压目录未发现本机 `E:\Philia093`、`C:\Users\ASUS`、疑似 `sk-*` 密钥或长 Bearer 字面量。
- 构建产物不保留 SDK 运行时依赖；Manifest 与最终入口均通过产物 smoke。

## 空宿主首次安装

使用上游真实 `PluginManager.installZip()` 在 `Cyrene-Agent-N/local-plugins/.test-runtime` 创建空宿主：

1. 分别从最终 `companion-memory.zip` 和 `companion-chat.zip` 导入；
2. 确认新导入插件默认均为 `disabled`，不会安装即运行；
3. 用户语义下显式启用后，两者均进入 `running`，无宿主 issue；
4. 记忆插件返回空库，聊天插件保持记忆联动默认关闭；
5. companion Prompt 可生成 life-context，并在触发词命中时生成 WorldBook；
6. 停止宿主后 IPC 全部释放，隔离测试目录删除。

该测试与 ZIP 替换／数据保留／卸载测试共同通过，隔离宿主共 7/7 项通过。

## 完整验证

- `npm.cmd run verify`：50 个测试文件通过、4 个按条件跳过；321 项通过、13 项跳过。
- TypeScript、插件构建、最终 ZIP 加载、工具契约和真实 PluginManager 隔离宿主均通过。
- 当前 `.test-runtime` 在验证后不存在；没有安装到正式 Cyrene，也没有读取或写入正式用户数据。

## 发布边界

- 本地安装可直接使用上述两个 ZIP。
- 若将来提交官方插件仓库，应按上游约定提交 `artifacts/<plugin-id>/` 目录而非 ZIP，并分别提交插件。
- 两个插件依赖本工作树新增的宿主 API 与 Chat 后端边界；不能承诺在未包含这些主程序补丁的原生旧版本中运行。
