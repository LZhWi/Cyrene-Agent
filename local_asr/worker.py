"""Cyrene local ASR JSON-lines worker.

stdin receives commands, stdout emits protocol events. Model/library logs are sent to
stderr where possible so Electron can reserve stdout for structured messages.
"""

from __future__ import annotations

import base64
import gc
import json
import os
import re
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

SENTENCE_PUNCTUATION_RE = re.compile(r"[，。！？；：,.!?;:]")
REPEATED_PUNCTUATION_RE = re.compile(r"([，。！？；：,.!?;:])(?:\s*\1)+")


def emit(kind: str, **payload: Any) -> None:
    sys.stdout.write(json.dumps({"type": kind, **payload}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    sys.stderr.write(f"[worker] {message}\n")
    sys.stderr.flush()


def pcm_to_float(pcm: bytes):
    import numpy as np

    if len(pcm) % 2:
        pcm = pcm[:-1]
    return np.frombuffer(pcm, dtype="<i2").astype("float32") / 32768.0


def missing_snapshot_weights(snapshot_path: str) -> list[str]:
    root = Path(snapshot_path)
    index_files = list(root.rglob("*.safetensors.index.json"))
    if index_files:
        expected: set[str] = set()
        for index_file in index_files:
            try:
                payload = json.loads(index_file.read_text(encoding="utf-8"))
                expected.update(str(name) for name in payload.get("weight_map", {}).values())
            except (OSError, ValueError, TypeError):
                return [index_file.relative_to(root).as_posix()]
        if not expected:
            return ["*.safetensors"]
        return sorted(name for name in expected if not (root / name).is_file())

    weights = list(root.rglob("*.safetensors"))
    for weight in weights:
        match = re.fullmatch(r"(.+)-(\d+)-of-(\d+)\.safetensors", weight.name)
        if not match:
            continue
        prefix, number_text, total_text = match.groups()
        total = int(total_text)
        width = len(number_text)
        expected = [weight.with_name(f"{prefix}-{index:0{width}d}-of-{total_text}.safetensors") for index in range(1, total + 1)]
        return [item.relative_to(root).as_posix() for item in expected if not item.is_file()]
    return [] if any(weight.is_file() for weight in weights) else ["*.safetensors"]


@dataclass
class Session:
    pcm: bytearray = field(default_factory=bytearray)
    para_pending: bytearray = field(default_factory=bytearray)
    para_cache: dict[str, Any] = field(default_factory=dict)
    para_text: str = ""
    next_qwen_partial_bytes: int = 0


class Pipeline:
    def __init__(self) -> None:
        self.profile = ""
        self.language = "zh"
        self.hotwords: list[str] = []
        self.qwen_model: Any = None
        self.para_model: Any = None
        self.punc_model: Any = None
        self.sessions: dict[str, Session] = {}

    def configure(self, profile: str, language: str, hotwords: list[str]) -> None:
        if profile not in {"qwen17-stream", "paraformer-qwen17", "qwen06-stream"}:
            raise ValueError(f"未知本地 ASR 方案：{profile}")
        self.language = language if language in {"zh", "en", "auto"} else "zh"
        self.hotwords = [str(word).strip() for word in hotwords if str(word).strip()][:200]
        if self.profile != profile:
            self._unload_models()
            self.profile = profile
            self._load_models()
        emit("ready", profile=self.profile)

    def _load_models(self) -> None:
        import torch
        from huggingface_hub import hf_hub_download, snapshot_download
        from modelscope.hub.snapshot_download import snapshot_download as ms_snapshot_download
        from qwen_asr import Qwen3ASRModel

        if not torch.cuda.is_available():
            log("未检测到 CUDA，将使用 CPU；Qwen 识别延迟可能很高")
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
        checkpoint = "Qwen/Qwen3-ASR-0.6B" if self.profile == "qwen06-stream" else "Qwen/Qwen3-ASR-1.7B"
        try:
            model_path = snapshot_download(checkpoint, local_files_only=True)
            missing_weights = missing_snapshot_weights(model_path)
            if missing_weights:
                raise FileNotFoundError(", ".join(missing_weights))
        except Exception:
            emit("status", phase="downloading", model=checkpoint)
            log(f"下载 {checkpoint}")
            model_path = snapshot_download(checkpoint)
            for filename in missing_snapshot_weights(model_path):
                if filename != "*.safetensors":
                    hf_hub_download(repo_id=checkpoint, filename=filename)
            model_path = snapshot_download(checkpoint, local_files_only=True)
            missing_weights = missing_snapshot_weights(model_path)
            if missing_weights:
                raise FileNotFoundError(
                    f"{checkpoint} 权重缓存不完整: {', '.join(missing_weights)}"
                )
        emit("status", phase="loading", model=checkpoint)
        log(f"加载 {checkpoint} 到 {device}")
        self.qwen_model = Qwen3ASRModel.from_pretrained(
            model_path,
            dtype=dtype,
            device_map=device,
            max_inference_batch_size=1,
            max_new_tokens=256,
        )

        from funasr import AutoModel

        punc_checkpoint = "iic/punc_ct-transformer_cn-en-common-vocab471067-large"
        try:
            punc_model_path = ms_snapshot_download(
                punc_checkpoint,
                local_files_only=True,
            )
        except Exception:
            emit("status", phase="downloading", model="ct-punc")
            log("下载 ct-punc")
            punc_model_path = ms_snapshot_download(punc_checkpoint)
        emit("status", phase="loading", model="ct-punc")
        log(f"从本地缓存加载 ct-punc 到 CPU: {punc_model_path}")
        self.punc_model = AutoModel(
            model=punc_model_path,
            device="cpu",
            disable_update=True,
            disable_pbar=True,
        )

        if self.profile == "paraformer-qwen17":
            emit("status", phase="loading", model="paraformer-zh-streaming")
            log("加载 paraformer-zh-streaming 到 CPU")
            self.para_model = AutoModel(model="paraformer-zh-streaming", device="cpu")

    def _unload_models(self) -> None:
        self.sessions.clear()
        self.qwen_model = None
        self.para_model = None
        self.punc_model = None
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    def start(self, session_id: str) -> None:
        interval_sec = 1.2 if self.profile == "qwen06-stream" else 2.0
        self.sessions[session_id] = Session(next_qwen_partial_bytes=int(16000 * 2 * interval_sec))

    def audio(self, session_id: str, pcm: bytes) -> None:
        session = self.sessions.get(session_id)
        if session is None:
            return
        session.pcm.extend(pcm)
        if self.profile == "paraformer-qwen17":
            session.para_pending.extend(pcm)
            self._drain_paraformer(session_id, session, is_final=False)
        elif len(session.pcm) >= session.next_qwen_partial_bytes:
            text = self._qwen_transcribe(bytes(session.pcm))
            if text:
                emit("partial", sessionId=session_id, text=text)
            interval_sec = 1.2 if self.profile == "qwen06-stream" else 2.0
            session.next_qwen_partial_bytes += int(16000 * 2 * interval_sec)

    def finish(self, session_id: str) -> None:
        session = self.sessions.pop(session_id, None)
        if session is None:
            emit("final", sessionId=session_id, text="")
            return
        if self.profile == "paraformer-qwen17" and session.para_pending:
            self._drain_paraformer(session_id, session, is_final=True)
        text = self._qwen_transcribe(bytes(session.pcm)) if session.pcm else ""
        text = self._restore_punctuation(text)
        emit("final", sessionId=session_id, text=text)

    def flush(self, session_id: str) -> None:
        session = self.sessions.get(session_id)
        if self.profile != "paraformer-qwen17" or session is None:
            return
        if not session.para_pending:
            session.para_pending.extend(bytes(1600 * 2))  # 100 ms silence releases decoder lookahead
        self._drain_paraformer(session_id, session, is_final=True)
        session.para_cache = {}

    def cancel(self, session_id: str) -> None:
        self.sessions.pop(session_id, None)

    def _drain_paraformer(self, session_id: str, session: Session, is_final: bool) -> None:
        import numpy as np

        chunk_bytes = 9600 * 2  # 600 ms at 16 kHz, 16-bit mono
        while len(session.para_pending) >= chunk_bytes or (is_final and session.para_pending):
            take = chunk_bytes if len(session.para_pending) >= chunk_bytes else len(session.para_pending)
            chunk = bytes(session.para_pending[:take])
            del session.para_pending[:take]
            final_chunk = is_final and not session.para_pending
            kwargs: dict[str, Any] = {
                "input": pcm_to_float(chunk),
                "cache": session.para_cache,
                "is_final": final_chunk,
                "chunk_size": [0, 10, 5],
                "encoder_chunk_look_back": 4,
                "decoder_chunk_look_back": 1,
            }
            if self.hotwords:
                kwargs["hotword"] = " ".join(self.hotwords)
            try:
                result = self.para_model.generate(**kwargs)
            except TypeError:
                kwargs.pop("hotword", None)
                result = self.para_model.generate(**kwargs)
            piece = str(result[0].get("text", "")).strip() if result else ""
            if piece:
                session.para_text += piece
                emit("partial", sessionId=session_id, text=session.para_text)

    def _qwen_transcribe(self, pcm: bytes) -> str:
        if not pcm:
            return ""
        language = {"zh": "Chinese", "en": "English"}.get(self.language)
        context = ""
        if self.hotwords:
            context = "可能出现的专有名词：" + "、".join(self.hotwords)
        results = self.qwen_model.transcribe(
            audio=(pcm_to_float(pcm), 16000),
            language=language,
            context=context,
        )
        text = str(results[0].text).strip() if results else ""
        if context and text.startswith(context):
            text = text[len(context):].lstrip(" ，,。.!！?？:：;；")
        return text

    def _restore_punctuation(self, text: str) -> str:
        if not text or self.punc_model is None:
            return self._normalize_punctuation(text)
        if SENTENCE_PUNCTUATION_RE.search(text):
            return self._normalize_punctuation(text)
        try:
            results = self.punc_model.generate(input=text)
            punctuated = str(results[0].get("text", "")).strip() if results else ""
            return self._normalize_punctuation(punctuated or text)
        except Exception:
            log("标点恢复失败，保留原始识别结果\n" + traceback.format_exc())
            return self._normalize_punctuation(text)

    @staticmethod
    def _normalize_punctuation(text: str) -> str:
        text = re.sub(r"\s+([，。！？；：,.!?;:])", r"\1", text.strip())
        return REPEATED_PUNCTUATION_RE.sub(r"\1", text)


def main() -> None:
    pipeline = Pipeline()
    for raw in sys.stdin:
        try:
            command = json.loads(raw)
            kind = command.get("type")
            session_id = str(command.get("sessionId", ""))
            if kind == "configure":
                pipeline.configure(
                    str(command.get("profile", "paraformer-qwen17")),
                    str(command.get("language", "zh")),
                    list(command.get("hotwords") or []),
                )
            elif kind == "start":
                pipeline.start(session_id)
            elif kind == "audio":
                pipeline.audio(session_id, base64.b64decode(command.get("pcm", "")))
            elif kind == "finish":
                pipeline.finish(session_id)
            elif kind == "flush":
                pipeline.flush(session_id)
            elif kind == "cancel":
                pipeline.cancel(session_id)
            elif kind == "shutdown":
                break
        except Exception as exc:
            log(traceback.format_exc())
            emit("error", sessionId=str(locals().get("session_id", "")), message=str(exc))


if __name__ == "__main__":
    main()
