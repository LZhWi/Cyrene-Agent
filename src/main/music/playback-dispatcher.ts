import { shell } from "electron";
import { ProtocolDetector } from "./protocol-detector";
import type { PlaybackDispatchResult } from "./types";

export class PlaybackDispatcher {
  constructor(private readonly detector: ProtocolDetector) {}

  async dispatch(resourceType: "song" | "playlist", resourceId: string): Promise<PlaybackDispatchResult> {
    const registered = await this.detector.isRegistered("orpheus");
    if (!registered) {
      return {
        state: "client_unavailable",
        resourceType,
        resourceId,
        errorCode: "E_PROTOCOL_NOT_REGISTERED",
      };
    }
    const payload = { type: resourceType, id: resourceId, cmd: "play" };
    const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const url = `orpheus://${b64}`;
    try {
      await shell.openExternal(url);
      return { state: "dispatched", resourceType, resourceId };
    } catch (err) {
      this.detector.invalidate();
      console.error("[music] openExternal failed", { errorCode: "E_OPEN_EXTERNAL_FAILED", err: String(err).slice(0, 200) });
      return { state: "launch_failed", resourceType, resourceId, errorCode: "E_OPEN_EXTERNAL_FAILED" };
    }
  }
}