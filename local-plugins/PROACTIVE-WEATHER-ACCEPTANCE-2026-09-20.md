# 屏幕观察、主动消息与天气边界隔离验收（2026-09-20）

## 结论

本阶段通过完整 Electron 主进程隔离验收。`companion-chat@0.9.0` 与
`companion-memory@0.48.0` 均由真实 `PluginManager` 启用；主动消息所需的
`weather-context` 宿主能力可解析；回应反馈学习默认关闭，只能由用户显式开启，且可再次关闭。
同一验收还确认梦境自动保存默认关闭、需要在后台梦境之外另行授权，关闭后台梦境会同步撤销授权。

测试没有修改正式用户数据。Roaming Cyrene、Local Cyrene、原项目 `UserData` 和
`UserData_backup` 四个保护根在运行前后均完成全树 SHA-256 校验，结果为
`protectedUserDataUnchanged=true`、`changedRoots=[]`。测试写入仅发生在
`Cyrene-Agent-N/.upstream-latest/local-plugins/.test-runtime/full-electron-host/run-*`
随机目录；进程退出后该目录已删除。

## 验收命令

```powershell
node scripts/run-full-electron-host-smoke.mjs --preflight
node scripts/run-full-electron-host-smoke.mjs --companion-acceptance
```

由于受保护的正式用户目录位于工作区外，两条命令均在获得授权后于沙箱外执行。预检只做
只读哈希，不启动 Electron，也不创建测试目录。完整验收在预检通过后才创建隔离目录，并将
`APPDATA`、`LOCALAPPDATA`、`USERPROFILE`、`HOME`、`TEMP`、npm cache 与 Electron
`userData` 全部重定向到该目录。

## 完整宿主结果

```json
{
  "ok": true,
  "exitCode": 0,
  "timedOut": false,
  "protectedUserDataUnchanged": true,
  "protectedRootCount": 4,
  "changedRoots": [],
  "isolatedUserDataConfirmed": true,
  "nativeChatMemoryDisabledConfirmed": true,
  "pluginsMentionedInOutput": true,
  "companionAcceptancePassed": true,
  "companionAcceptance": {
    "pluginLoaded": true,
    "weatherCapabilityResolved": true,
    "feedbackDefaultOff": true,
    "feedbackExplicitOptIn": true,
    "feedbackCanDisable": true,
    "dreamAutoApplyDefaultOff": true,
    "dreamAutoApplyExplicitOptIn": true,
    "dreamAutoApplyClearedWithScheduler": true
  }
}
```

宿主还确认截图辅助进程被隔离探针拦截；权限档位保持默认 `read-only`；RAG 向量库不可写时
跳过 reconciliation；未发现凭据泄漏。运行中出现的 GPU shared-context 错误来自隐藏且禁用
GPU 的测试环境，未影响主进程、插件加载、验收断言或退出清理，不属于生产功能失败。

## 自动化与构建基线

在本阶段收口前已通过：

- 主程序天气、插件宿主与相关编排的定向测试：5 个文件、40 项测试；
- 主程序较宽回归：26 个文件、258 项测试；另有 2 个套件因离线环境尝试下载 Electron
  而未能启动，不是断言失败；
- 主程序构建；
- 插件测试：48 个文件通过、4 个文件按条件跳过；共 305 项通过、11 项按条件跳过；
- 插件 typecheck、build、host-smoke、artifact smoke；
- SDK schema、打包与示例验证。

本次为改善失败时的可审计性，隔离守卫还会报告不可读项的相对路径、操作类型和错误码；
校验规则没有放宽，任何不可读项仍会在创建运行目录或启动 Electron 前拒绝执行。

## 边界

- 本次验收证明宿主边界、插件加载、配置默认值、显式 opt-in 和数据隔离成立；不代表主动消息
  在所有真实桌面情境下的文案质量已经完成长期观察。
- 天气能力只向插件提供有期限的结构化非定位快照，不公开城市、坐标、密钥或天气源配置。
- Work、Code、Learn、朋友圈和外部渠道仍不在当前 Chat／Collab 复刻范围内。
