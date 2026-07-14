# Upstream

- 仓库：https://github.com/Code-MonkeyZhang/cloud-music-mcp
- Commit SHA：63fc2409fef04f7205f4f9987f89d36aca87ac5b
- Vendored 日期：2026-07-15

## 本项目补丁

| 文件 | 改动 | 目的 |
|---|---|---|
| `auth.py` | 末尾追加 `begin_login` / `check_login` / `cancel_login` / `validate_session_three_state` + 模块级 `_PENDING_SESSIONS` 单例状态机；新增 `STORAGE_DIR` 读取 `CYRENE_MUSIC_STORAGE_DIR` 环境变量；新增 Cookie 写入 `tempfile + os.replace` 原子写；新增 `_sanitize` 日志脱敏 | 提供非阻塞扫码会话接口、复用 pyncm 完成 weapi 加密、消除对 `os.startfile` 的依赖 |
| `tests/test_auth.py` | 新增 5 个测试用例覆盖 `begin_login` 单会话 / `login_already_active` / pyncm code 映射 / `authorized`+`credentialRevision` / `cancel_login` 幂等 | 单元测试 |
| `pyproject.toml` | 新增 `[tool.uv] dev-dependencies = ["pytest>=8.0"]` | 让 venv 自带 pytest，便于 vendored 项目独立跑测试 |
| `uv.lock` | 自动 lock 后含 pytest 依赖 | 与 pyproject.toml 保持一致 |
| `.gitignore` | 新增 `src/cloud_music_mcp.egg-info/` | 忽略 `uv sync` 生成的本地构建产物 |

## 测试运行

```bash
cd vendor/cloud-music-mcp
uv sync
uv run --frozen python -m pytest tests/test_auth.py -v
```

> 在 Windows 上必须用 `python -m pytest` 而不是直接 `pytest`，因为 PATH 里的 pytest 可能来自其他 venv，不会带 vendored 项目的 editable install。

## 同步上游

1. `git fetch upstream`
2. 对照本补丁表合并（注意 `.gitignore`、UPSTREAM.md、pyproject.toml 的 dev-dependencies 可能与上游冲突）
3. 重新跑 `vendor/cloud-music-mcp` 下的单元测试
4. 更新本文件 SHA 行