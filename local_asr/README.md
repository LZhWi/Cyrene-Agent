# 本地长音频转写

长音频转写复用语音通话使用的 `local_asr/worker.py`、Qwen3-ASR 和标点恢复模型。
音频只在本机处理，命令不会调用聊天模型，也不会把转写结果自动加入文档索引。

## 设置界面

在应用中打开“设置 → ASR”，把识别引擎切换为“本地”，然后在“长音频转写”区域选择 Markdown、TXT 或 Word（DOCX）格式，以及是否包含分段时间戳，再选择音频、保存目录和文件名。无需预先创建输出文件；省略扩展名时系统会按照所选格式自动补全。点击“开始转写”后可以关闭设置窗口，任务会继续；重新打开 ASR 设置即可查看当前进度。完成后可直接打开结果，取消时已经生成的片段会保留为临时文本。

`流式 + 高精度`方案在长音频任务中使用 Qwen 1.7B 做最终识别；`轻量单模型`使用 Qwen 0.6B。转写期间，语音通话和麦克风测试会暂时不可启动，以免多个本地语音模型争用资源。

## 命令行

在项目目录中先编译，然后直接运行 Node 脚本。这样可以避开 Windows 上 `npm run --`
转发带空格路径时可能产生的 `^` 转义问题：

```powershell
npm.cmd run build:main
node .\scripts\transcribe-local-audio.mjs --input "E:\path with spaces\audio.m4a" --output "E:\path with spaces\transcript.md" --profile qwen17-stream --language zh
```

可重复提供 `--hotword` 来改善专有名词，例如：

```powershell
node .\scripts\transcribe-local-audio.mjs --input "E:\path\audio.m4a" --output "E:\path\transcript.md" --hotword "空洞骑士" --hotword "圣巢"
```

输出 TXT 或 DOCX、并关闭时间戳：

```powershell
node .\scripts\transcribe-local-audio.mjs --input "E:\path\audio.m4a" --output "E:\path\transcript.docx" --format docx --no-timestamps
```

- 默认使用 `qwen17-stream`；可改为占用较低、速度更快的 `qwen06-stream`。
- 首次使用某个模型时可能需要下载权重。
- 工具优先在静音处按约 45 秒分段，单段最长 60 秒。
- Markdown/TXT 完成前写入 `<output>.partial`；DOCX 转写期间写入 `<output>.partial.txt`。中断时临时文件保留已经完成的片段。
- 已存在输出时命令会停止。确认需要覆盖后添加 `--force`。
- 输出是带时间戳的 Markdown。检查后可作为普通文档上传，进入文档语义索引。
