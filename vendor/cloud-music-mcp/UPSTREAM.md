# Upstream

- 仓库：https://github.com/Code-MonkeyZhang/cloud-music-mcp
- Commit SHA：63fc2409fef04f7205f4f9987f89d36aca87ac5b
- Vendored 日期：2026-07-15

## 本项目补丁

| 文件 | 改动 | 目的 |
|---|---|---|
| 文件 | 改动 | 目的 |
|---|---|---|
| `auth.py` | 末尾追加 `begin_login` / `check_login` / `cancel_login` / `validate_session_three_state` + 模块级 `_PENDING_SESSIONS` 单例状态机；新增 `STORAGE_DIR` 读取 `CYRENE_MUSIC_STORAGE_DIR` 环境变量；新增 Cookie 写入 `tempfile + os.replace` 原子写；新增 `_sanitize` 日志脱敏 | 提供非阻塞扫码会话接口、复用 pyncm 完成 weapi 加密、消除对 `os.startfile` 的依赖 | 
| `tests/test_auth.py` | 新增 5 个测试用例覆盖 `begin_login` 单会话 / `login_already_active` / pyncm code 映射 / `authorized`+`credentialRevision` / `cancel_login` 幂等 | 单元测试 |

## 同步上游

1. `git fetch upstream`
2. 对照本补丁表合并
3. 重新跑 `vendor/cloud-music-mcp` 下的单元测试
4. 更新本文件 SHA 行