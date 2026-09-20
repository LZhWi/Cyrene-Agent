# 主动消息“忽略”反馈验收（2026-09-20）

## 结论

`companion-chat@0.10.0` 已补齐本地版主动消息的显式“忽略”反馈边界：

- 回应反馈学习仍默认关闭，只有用户主动开启后，自动主动消息才请求显示“忽略”；
- 手动测试消息不参与反馈学习，也不会显示“忽略”；
- 按钮只允许作用于主动会话最后一条仍为 `pending` 的插件模型消息；
- 宿主先把该消息原子标为 `ignored`，再向原发送插件发布结构化反馈事件；
- 插件只接受属于自身且与最后一次真实投递回执完全匹配的消息 ID；
- 同一消息最多结算一次，忽略会降低对应场景 affinity，但不会删除消息或清空未回复计数。

插件不能任意修改聊天历史。新增能力仍受 `assistant-delivery` 依赖、插件运行状态、主动会话用途、
最后一条消息和一次性状态共同约束；事件只包含插件 ID、会话 ID、消息 ID 与 `ignore` 动作，不携带正文。

## 分层验证

主程序定向回归覆盖了投递选项验证、消息元数据落盘、只允许最后一条主动消息结算、IPC
一次性语义、生命周期事件、预加载桥接、UI 元数据传递和按钮显示条件：

```powershell
npm.cmd test -- --run src/main/plugin-host/assistant-delivery-service.test.ts src/main/plugin-host/host-services.test.ts src/main/plugin-host/lifecycle-publisher.test.ts src/main/chats/chats-store.test.ts src/main/chats/chats-ipc.test.ts src/renderer/react/features/chat/components/ChatMessageList.test.ts src/renderer/react/features/chat/pages/chat-page-normalizers.test.ts
```

结果：7 个测试文件、53 项测试全部通过。

插件定向回归覆盖了默认关闭、开启后自动投递请求按钮、错误消息 ID 不结算、正确消息 ID
只结算一次，以及手动测试消息不参与反馈：

```powershell
npm.cmd test -- --run tests/proactive-controller.test.ts tests/companion.test.ts
```

结果：2 个测试文件通过；37 项通过、1 项按条件跳过。

插件全量验证：

```powershell
npm.cmd run verify
```

结果：类型检查、构建、host smoke 和产物 smoke 全部通过；48 个测试文件通过、4 个文件按条件
跳过，311 项通过、11 项按条件跳过。SDK schema、类型声明、示例和 npm pack dry-run 也已通过。
主程序 `build:main`、`build:preload` 与 `build:renderer` 均通过。

主程序全量 Vitest 额外得到 382 个文件、3153 项通过。其余失败均发生在测试初始化或系统边界：

- 78 个套件尝试下载 Electron，但隔离环境禁止网络访问；
- 5 项依赖写入 `C:\cyrene-test-user-data` 或 `C:\cyrene-characterization`，被沙箱拒绝；
- 8 项真实子进程终止测试受沙箱进程权限限制；
- 与 Electron 导入相连的少量断言因同一安装检查失败而未能执行。

上述失败没有命中本次改动的定向测试，也没有出现“忽略”链路断言失败。

## 完整 Electron 隔离验收

重建插件产物后执行：

```powershell
node scripts/run-full-electron-host-smoke.mjs --companion-acceptance
```

真实 `PluginManager` 明确加载 `companion-chat@0.10.0` 与 `companion-memory@0.50.0`，结果为：

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
  "companionAcceptancePassed": true,
  "companionAcceptance": {
    "feedbackDefaultOff": true,
    "feedbackExplicitOptIn": true,
    "feedbackCanDisable": true,
    "feedbackIpcFirstAccepted": true,
    "feedbackPersistedIgnored": true,
    "feedbackIpcRepeatRejected": true
  }
}
```

宿主实测确认回应反馈学习默认关闭、可由用户显式开启并再次关闭；同一运行还在一次性主动会话中
构造 `pending` 消息，并穿过真实 preload／IPC／会话存储／插件事件总线：首次调用成功、落盘状态变为
`ignored`、第二次调用被拒绝。定向插件测试验证该事件对 affinity 只结算一次。完整 Electron 运行没有
调用真实模型，权限档位保持 `read-only`，截图辅助进程被隔离探针拦截。

Roaming Cyrene、Local Cyrene、原项目 `UserData` 与 `UserData_backup` 四个保护根在运行前后均完成
全树 SHA-256 校验，结果为 `protectedUserDataUnchanged=true`、`changedRoots=[]`。Electron 的
`APPDATA`、`LOCALAPPDATA`、`USERPROFILE`、`HOME`、`TEMP`、npm cache 与 `userData` 全部重定向到
`Cyrene-Agent-N` 内的一次性目录；退出后本次临时快照与运行数据已清除。

## 已知边界

- 本阶段证明显式按钮、宿主一次性约束和插件负反馈结算成立；长期 affinity 学习效果仍需真实使用观察。
- 反馈学习关闭时，不会请求按钮，也不会因用户下一次开口自动结算正负反馈。
- Work、Code、Learn、朋友圈和外部渠道不在该按钮的适用范围内。
