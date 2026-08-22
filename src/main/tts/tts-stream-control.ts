interface ActiveTtsStream {
  senderId: number;
  controller: AbortController;
}

export class TtsStreamControlRegistry {
  private readonly active = new Map<string, ActiveTtsStream>();

  start(streamId: string, senderId: number): AbortSignal {
    if (!/^tts-[A-Za-z0-9-]{8,100}$/.test(streamId)) throw new Error("E_INVALID_TTS_STREAM_ID");
    if (this.active.has(streamId)) throw new Error("E_TTS_STREAM_ID_CONFLICT");
    const controller = new AbortController();
    this.active.set(streamId, { senderId, controller });
    return controller.signal;
  }

  cancel(streamId: string, senderId: number): boolean {
    const stream = this.active.get(streamId);
    if (!stream || stream.senderId !== senderId) return false;
    this.active.delete(streamId);
    stream.controller.abort(new DOMException("语音合成已取消", "AbortError"));
    return true;
  }

  finish(streamId: string): void {
    this.active.delete(streamId);
  }
}
