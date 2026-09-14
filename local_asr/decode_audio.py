"""Decode an audio file to 16 kHz mono signed 16-bit PCM using PyAV."""

from __future__ import annotations

import argparse
from pathlib import Path

import av


def decode(input_path: Path, output_path: Path) -> None:
    with av.open(str(input_path)) as container, output_path.open("wb") as output:
        stream = next((item for item in container.streams if item.type == "audio"), None)
        if stream is None:
            raise ValueError("文件中没有音频流")
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        for frame in container.decode(stream):
            for converted in resampler.resample(frame):
                output.write(converted.to_ndarray().astype("<i2", copy=False).tobytes())
        for converted in resampler.resample(None):
            output.write(converted.to_ndarray().astype("<i2", copy=False).tobytes())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    decode(args.input.resolve(), args.output.resolve())


if __name__ == "__main__":
    main()
