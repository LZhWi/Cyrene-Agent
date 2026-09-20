# 动态 Prompt Provider 顺序验收记录（2026-09-20）

## 问题

上游 Prompt Registry 原本并行构建多个 Provider，但只按注册顺序拼接。跨插件注册顺序来自目录扫描与
启用顺序，不是稳定 API 契约。`companion-chat` 与 `companion-memory` 因此不能保证本地 Soul 需要的
动态层近端顺序。

## 最小改动

- `PluginPromptProvider` 新增可选 `priority`，范围为 -1000 至 1000 的安全整数；数值越小越靠前。
- 未声明时等价于 0；同值使用 JavaScript 稳定排序保留原注册顺序，旧插件行为不变。
- Provider 仍并行执行；只在收集结果时排序，单项／总预算、超时隔离与消费回执均不变。
- companion 动态层固定为 life=100、memory=200、WorldBook=300。

这只是顺序边界，没有合并各插件的存储或生命周期，也没有让插件读取宿主私有数据。

## 验证结果

- `src/plugins/prompts.test.ts`、`src/plugins/api.test.ts`、`src/main/orchestrator/build-options.test.ts`：
  3 个文件、86 项测试通过；覆盖跨插件排序、同优先级稳定性和非法范围拒绝。
- `npm.cmd run build:main` 通过。
- `npm.cmd run check:plugin-sdk` 在工作树内临时 npm 缓存下完成，SDK 打包校验通过；缓存随后删除。
- `local-plugins npm.cmd run verify`：50 个测试文件通过、4 个按条件跳过；321 项通过、13 项跳过；
  TypeScript、两个插件构建和 ZIP 加载 smoke 全部通过。随后新增真实构建产物顺序用例，隔离宿主
  7 项全部通过，直接确认 life → memory → WorldBook，并同时确认合成记忆与触发 WorldBook 正文可见；
  新增用例从空宿主导入两个发布 ZIP，确认默认停用、显式启用和共同运行。
- 保留宿主 32000 字符总预算：当前 46 条 WorldBook 无常驻项且单轮最多激活 8 条；全部触发词同时
  命中的回归测试确认 WorldBook 块小于 8000 字符，和 15500 字符记忆预算及 life 段组合仍有余量。
- 测试仅只读复用 `Cyrene-Agent/node_modules/electron/dist` 解析 Electron 模块；未启动或修改本地正式程序，
  未读取、复制或写入用户数据。
- 验收后精确删除 `local-plugins/.test-runtime`；其中共 999 个历次测试顶层临时项，删除后目录不存在。

## 完整 Electron 原生 Chat 复核

在原版 Cyrene 正常退出后执行只读 preflight，再以 `--native-turn` 启动隐藏的一次性隔离宿主。测试只用
合成会话和固定回复，不复制真实数据、不调用网络或真实模型。

- 两个构建产物由真实 PluginManager 启用，桌面 Chat 冻结为 `companion` 后端；
- 模型实际接收的动态上下文头严格按 life → memory → WorldBook 出现，不只验证 Registry 单元输出；
- WorldBook 只有命中“白厄”的轮次推进一次 revision，未命中的首轮不伪造提交；
- 本地 Tool→Soul 稳定人格协议仍存在，已失效的 `playwright-browser_*` 说明不存在；
- 结果为 `ok=true`、`nativeTurnPassed=true`、`promptProviderOrderPassed=true`、
  `companionLifeStatusVisible=true`；
- 四个受保护数据根前后哈希一致，`changedRoots=[]`；本次运行目录退出后已删除。

首次复核曾因两条旧测试预期失败：把单次 WorldBook 命中误要求为 revision ≥2，并把本地两阶段协议本身
误判为旧协议。新增加的顺序与旁路断言当时均已通过；核对实现和人格单测后只修正验收脚本，没有为了
通过测试修改产品行为。
