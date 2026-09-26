# 用户数据硬隔离验收（2026-09-21）

## 目标

- Cyrene-Agent-N 不得默认使用正式版 `live2d-cyrene` 用户目录。
- 本地主项目 schema 6 记忆不得被上游 schema 2 MemoryStore 原地降级。
- 普通启动使用 Cyrene-Agent-N 内的持久目录；临时验收入口退出后清理。
- 真实用户数据只读校验，不启动正式版，也不调用模型。

## 实现边界

- `src/main/user-data-safety.ts` 在任何业务子系统初始化前预检 Electron `userData`。
- 默认正式版目录、较新记忆 schema、本地对象型 DMAE 或本地专有顶层字段都会阻止启动。
- `scripts/run-isolated-app.mjs` 把 `APPDATA`、`LOCALAPPDATA`、HOME、TEMP 和 Electron
  `userData` 全部重定向到 Cyrene-Agent-N 内。
- `npm start`、`npm run start:isolated` 和 `npm run dev` 使用持久的 `Cyrene-Agent-N/AppData`。
- `npm run start:temporary` 和 `npm run dev:temporary` 使用 `.runtime/session-*`，退出后删除。
- 持久用户目录必须为空或包含有效 `.cyrene-n-user-data.json` 归属标记；非空无标记、链接目录和
  越界路径均拒绝使用。
- 本保护层不迁移、不复制、不修复任何真实用户文件。已有显式单向导入继续从只读快照进入插件私有库。

## 验收结果

1. `src/main/user-data-safety.test.ts`：5/5 通过。
   - 拒绝正式版默认目录。
   - 允许空隔离目录。
   - 拒绝 schema 6 且源文件逐字不变。
   - 允许宿主当前 schema 2 的隔离数据。
   - 允许宿主按原有迁移逻辑补齐缺省数组的旧隔离数据。
2. `src/main/index.test.ts` 与安全测试合跑：2 个测试文件、10 个测试全部通过。
3. `npm run build:main`：通过。
4. 对真实目录执行编译后纯只读预检：正确返回拒绝。
5. 对真实 `memory.json`、应用设置、模型设置、聊天索引和 2 个会话文件执行预检前后
   SHA-256 对比：共 6 个文件，变化数为 0。

## 可见启动回归修复

- 首次可见验收发现当前 Electron 在 `ready` 前调用 `app.getPath("appData")` 会抛出
  `Failed to get 'appData' path`。该异常发生在所有业务初始化之前，没有读写用户数据。
- 入口改为继续使用 Electron 已可用的 `userData`，并从 `APPDATA` 环境变量取得比较基准；
  非 Windows 环境只读使用 `userData` 父目录作为回退。保护规则及临时目录边界不变。
- 修复后重新构建并运行完整隔离宿主：窗口阶段正常到达、两个 companion 插件正常启停，
  `protectedUserDataUnchanged=true`、`protectedRootCount=4`、`changedRoots=[]`。
- 完整运行未调用真实模型；截图辅助进程、Sandbox 子进程和不可写原生向量校准按验收规则被拦截或降级。
- 隔离宿主退出后报告“本次临时快照及运行数据已清除”。

## 尚未执行

- 无。用户已通过 `npm start` 完成实际入口的可见启动并正常退出。

## 实际入口退出后验收

- `Cyrene-Agent-N/.runtime`：不存在。
- `.upstream-latest/.runtime`：不存在。
- 残留 Electron 进程：0。
- 只读扫描正式 `Roaming/live2d-cyrene`：从本次启动前的验收时间点起，没有新增或改写文件，计数 0。
- 结合启动前完整宿主的四根全树哈希 `changedRoots=[]`，本轮实际入口没有把正式用户目录挂载为运行目录。

## 持久隔离目录

- 持久根：`Cyrene-Agent-N/AppData`。
- Electron userData：`AppData/Roaming/live2d-cyrene-n`。
- 本目录只归 Cyrene-Agent-N 使用，不复制或迁移正式版用户数据。
- 真实数据继续只能经只读快照和显式单向导入进入插件私有库。
- 持久与临时路径预检均通过；临时预检结束后 `.runtime` 不存在。
- 编译后主进程安全断言：持久目录返回 `safe=true`，正式用户目录返回 `safe=false`。
