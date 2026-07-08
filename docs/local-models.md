# 本地 AI 模型

Cyrene 默认使用云端 LLM 推理服务，无需下载本地模型即可使用基础聊天功能。

## 模型包下载

点击前往 GitHub Releases 下载：

- [Cyrene-Agent-Models-Embedding-BGE.zip](https://github.com/Playa-0v0/Cyrene-Agent/releases) — Embedding 模型（约 570MB）
- [Cyrene-Agent-Models-Reranker-Light.zip](https://github.com/Playa-0v0/Cyrene-Agent/releases) — 轻量排序模型（约 23MB）

### 使用方法

解压后直接覆盖到 Cyrene-Agent 项目根目录。**注意目录结构**——

Embedding 模型必须放在 `models/Xenova/<repo>/` 下，因为 `@xenova/transformers` 在加载时会自动拼接 `Xenova/` 前缀：

```
Cyrene-Agent/                         ← 项目根目录
├── models/
│   ├── Xenova/
│   │   ├── bge-m3/                   ← Embedding 模型
│   │   │   ├── tokenizer.json
│   │   │   ├── config.json
│   │   │   └── onnx/model_quantized.onnx
│   │   └── all-MiniLM-L6-v2/         ← 文档 / 记忆 Embedding
│   ├── bge-reranker-base/            ← 标准排序（可选）
│   └── ms-marco-MiniLM-L-6-v2/       ← 轻量排序
```

无需额外配置，重启应用即可。

> ⚠️ 不要把 `bge-m3/` 直接放在 `models/` 根下，必须有 `Xenova/` 这一层目录，否则
> transformers 会去 `~/.cache/huggingface/Xenova/bge-m3/` 兜底，找不到本地模型
> 会报 `local_files_only=true` 错误。

### HuggingFace 缓存作为兜底

如果项目根 `models/Xenova/<repo>/` 下找不到模型，Cyrene 会自动尝试
`~/.cache/huggingface/Xenova/<repo>/`（huggingface-cli 下载的默认位置）。

## Embedding 模型

| 模型 | 用途 | 说明 |
|------|------|------|
| bge-m3 | 贴纸语义匹配 + 场景语气注入 | **推荐**，中文效果优秀 |

> ⚠️ 贴纸语义匹配依赖 bge-m3，不支持 fallback 到其他模型。模型缺失时该功能自动关闭。

每个模型目录需包含：
- `tokenizer.json`
- `config.json`
- `onnx/model_quantized.onnx`

## Reranker 模型（可选）

| 模型 | 用途 | 大小 | 推荐度 |
|------|------|------|--------|
| ms-marco-MiniLM-L-6-v2 | 轻量排序 | ~23MB | ⭐ 入门 |
| bge-reranker-base | 标准排序 | ~279MB | ⭐⭐ 进阶（后续发布） |

## 模型缺失不影响基础功能

当本地模型不存在时，Cyrene 会：

- 自动关闭对应增强功能
- 打印警告日志
- 保证聊天功能继续工作

## 排查："模型已下载但识别不到"

如果设置页一直显示"未下载"，或启动报
`local_files_only=true ... file was not found locally at .../tokenizer.json`：

1. **目录层级对不对**——必须是 `models/Xenova/<repo>/`，不能直接 `models/<repo>/`
2. **三个关键文件是否齐全**——
   ```
   models/Xenova/bge-m3/
   ├── tokenizer.json
   ├── config.json
   └── onnx/model_quantized.onnx
   ```
3. **大小写**——Linux/macOS 区分大小写，`Bge-M3` ≠ `bge-m3`
4. **重启应用**——模型检测在启动时一次性完成
5. **看 main 日志**——会打印具体查的是哪个目录、缺哪个文件

## 国内下载（备选）

如需手动下载，可使用 HuggingFace 镜像：

https://hf-mirror.com/
