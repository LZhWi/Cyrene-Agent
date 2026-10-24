# SQLite 隔离运行支持

这些运行支持文件来自已验收的隔离候选。普通 `npm start` 仍使用 JSON；没有自动迁移或正式 SQLite 开关。

`getStorageRuntime()` 仅在 `CYRENE_SQLITE_ISOLATION=1` 时尝试加载，并必须通过 `isolation-boundary.cjs` 的临时安装、数据和用户目录校验。不要直接给正式启动设置这个变量。

隔离构建须将此目录的 CJS 文件放入隔离 app 根目录、runtime 放入隔离 stage/runtime，并单独构建 SQLite worker/client。当前可复现构建和验收记录位于 `.runtime/life-integration-results-20261025`。正式用户目录及已安装插件不会由这些源码自动替换。
