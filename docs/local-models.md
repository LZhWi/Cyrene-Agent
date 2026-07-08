# 本地 AI 模型

Cyrene 默认使用云端 LLM 推理服务，无需下载本地模型即可使用基础聊天功能。

## Embedding 模型（可选）

| 模型 | 用途 | 最小路径 |
|------|------|----------|
| all-MiniLM-L6-v2 | 贴纸语义匹配 | `models/all-MiniLM-L6-v2/` |
| bge-m3 | 场景语气注入（中文效果更好） | `models/bge-m3/` |

每个模型目录需包含：
- `tokenizer.json`
- `config.json`
- `onnx/model_quantized.onnx`

## Reranker 模型（可选）

| 模型 | 用途 | 路径 | 大小 |
|------|------|------|------|
| ms-marco-MiniLM-L-6-v2 | 轻量排序 | `models/ms-marco-MiniLM-L-6-v2/` | ~23MB |
| bge-reranker-base | 标准排序 | `models/bge-reranker-base/` | ~279MB |

## 模型缺失不影响基础功能

当本地模型不存在时，Cyrene 会：

- 自动关闭对应增强功能
- 打印警告日志
- 保证聊天功能继续工作

## 官方模型包

未来将提供独立模型包下载，解放 HuggingFace 下载烦恼。

## 国内下载（可选）

如需手动下载，可使用 HuggingFace 镜像：

https://hf-mirror.com/

## 目录结构示例

```
models/
├── all-MiniLM-L6-v2/
│   ├── tokenizer.json
│   ├── config.json
│   └── onnx/
│       └── model_quantized.onnx
├── bge-m3/
│   ├── tokenizer.json
│   ├── config.json
│   └── onnx/
│       └── model_quantized.onnx
├── ms-marco-MiniLM-L-6-v2/
│   ├── tokenizer.json
│   ├── config.json
│   └── onnx/
│       └── model_quantized.onnx
└── bge-reranker-base/
    ├── tokenizer.json
    ├── config.json
    └── onnx/
        └── model_quantized.onnx
```
