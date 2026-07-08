# 本地 AI 模型

Cyrene 默认使用云端 LLM 推理服务，无需下载本地模型即可使用基础聊天功能。

## 模型包下载

点击前往 GitHub Releases 下载：

- [Cyrene-Agent-Models-Embedding-BGE.zip](https://github.com/Playa-0v0/Cyrene-Agent/releases) — Embedding 模型（约 570MB）
- [Cyrene-Agent-Models-Reranker-Light.zip](https://github.com/Playa-0v0/Cyrene-Agent/releases) — 轻量排序模型（约 23MB）

### 使用方法

解压后直接覆盖到 Cyrene-Agent 项目根目录：

```
Cyrene-Agent/          ← 项目根目录
├── models/
│   ├── bge-m3/       ← 解压后得到
│   └── ...
```

无需额外配置，重启应用即可。

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

## 国内下载（备选）

如需手动下载，可使用 HuggingFace 镜像：

https://hf-mirror.com/
