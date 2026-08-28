# QQ / NapCat（OneBot 11）接入指南

Cyrene 通过 OneBot 11 反向 WebSocket 接入 NapCat：Cyrene 在 Windows 监听，NapCat 作为 WebSocket Client 主动连接。该接入不会修改或替换 NapCat 中已有的 AstrBot 连接。

## 前置条件

- Windows 10/11 上运行 Cyrene。
- NapCat `4.8.115+`。旧版本仍可处理文本和小型出站图片/语音，但完整跨 WSL 文件流不可用。
- 一个独立 QQ 机器人账号。首版每个 Cyrene 实例只接受一个 QQ 账号连接。

## 配置 Cyrene

1. 打开系统托盘中的“设置” → “连接手机” → “QQ（NapCat / OneBot 11）”。
2. 开启 QQ 渠道。
3. 选择监听模式：
   - NapCat 在 WSL/Docker：选择“自动”或“Windows WSL 虚拟网卡”。
   - NapCat 与 Cyrene 同在 Windows：选择“仅本机 127.0.0.1”。
   - 只有明确知道监听地址时才使用“自定义地址”。
4. 保持默认端口 `6200`，填写私聊 QQ 白名单和群号白名单。
5. Access Token 可选。跨网络使用时建议点击“生成”，先复制 Token，再保存配置。
6. 点击“保存并启动监听”，复制页面显示的 NapCat 连接 URL。

> WSL NAT 地址可能在 WSL 重启后变化。每次连接失败时，以 Cyrene 设置页实时显示的 URL 为准，不要长期写死旧 IP。

## 配置 NapCat

在 NapCat WebUI 的 OneBot 网络配置中**新增**一个 WebSocket Client，不要编辑或删除现有 AstrBot Client：

| 字段 | 值 |
| --- | --- |
| Enable | 开启 |
| URL | Cyrene 设置页显示的完整 URL，例如 `ws://172.x.x.1:6200/onebot/v11/ws` |
| Message Post Format | `array` |
| Report Self Message | 关闭 |
| Reconnect Interval | `5000` ms |
| Heart Interval | `30000` ms |
| Token | 与 Cyrene 中生成的 Token 相同；Cyrene 留空时这里也留空 |

保存后，Cyrene 状态应从“等待 NapCat 连接”变为“NapCat 已连接”。点击“测试连接”可查看 QQ 号、昵称、NapCat 版本和 Stream API 状态。

## 消息与权限规则

- 私聊只有 `allowedPrivateUserIds` 中的 QQ 号会触发 Cyrene。
- 群聊只有白名单群中的 `@机器人` 消息会触发；回复固定引用原消息并 @ 发送者。
- 同一群共享会话历史和 Cyrene 的个人长期记忆。只应添加可信群，避免私密记忆出现在不可信场景。
- QQ 群聊强制使用 Chat 流程，不调用工具；QQ 私聊沿用“连接手机”页面的全局工具权限设置。
- QQ 主动投递、好友/加群申请、通知事件、戳一戳和合并转发不在首版范围内。

## 多媒体与缓存

- 小于等于 8 MiB 的出站图片和语音使用 `base64://`。
- 更大的图片/语音以及文件、视频使用 NapCat Stream API，默认 64 KiB 分片。
- 单文件上限为 100 MiB。
- 下载缓存位于 `<userData>/channels/cache/qq/`，文件保留 24 小时，总量上限 512 MiB。
- NapCat 低于 `4.8.115` 或 Stream API 不可用时，设置页会显示兼容性警告。

## 排障

- **一直显示“等待 NapCat 连接”**：确认 NapCat 配置的是 WebSocket Client，不是 WebSocket Server；URL 路径必须包含 `/onebot/v11/ws`。
- **401 Unauthorized**：两侧 Token 不一致。Token 不会从 Cyrene 设置中回显，遗失后请重新生成并同步更新 NapCat。
- **WSL 中无法连接**：重新保存 Cyrene 配置并复制新的实时 URL；同时检查 Windows 防火墙是否允许来自 WSL 虚拟网卡的端口 `6200`。
- **群聊不回复**：确认群号在白名单中，并且消息段实际 @ 了机器人 QQ。
- **媒体显示处理失败**：检查 NapCat 版本及 Stream API 状态；文件不能超过 100 MiB。
