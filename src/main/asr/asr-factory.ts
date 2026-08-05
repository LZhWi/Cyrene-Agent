import { LocalAsrStream, shutdownLocalAsr, type LocalAsrStatus } from "./local-asr-engine";
import { VolcanoAsrStream, type AsrConfig } from "./volcano-asr-engine";

export interface AsrStream {
  start(): Promise<void>;
  sendAudio(frame: Buffer): void;
  flush?(): void;
  finish(): Promise<void>;
  stop(): void;
}

export function createAsrStream(
  config: AsrConfig,
  onPartial: (text: string) => void,
  onFinal: (text: string) => void,
  onStatus?: (status: LocalAsrStatus) => void,
): AsrStream {
  if (config.engine === "local") {
    const stream = new LocalAsrStream(onPartial, onFinal, onStatus);
    return {
      start: () => stream.start(config),
      sendAudio: (frame) => stream.sendAudio(frame),
      flush: () => stream.flush(),
      finish: () => stream.finish(),
      stop: () => stream.stop(),
    };
  }

  const stream = new VolcanoAsrStream(onPartial, onFinal);
  return {
    start: () => stream.start(config.appKey, config.accessKeyId, config.accessKeySecret, config.language),
    sendAudio: (frame) => stream.sendAudio(frame),
    finish: () => stream.finish(),
    stop: () => stream.stop(),
  };
}

export function shutdownAsrRuntimes(): void {
  shutdownLocalAsr();
}
