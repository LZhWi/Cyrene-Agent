import { describe, it, expect, beforeEach, vi } from "vitest";

const { openExternal, getAppInfo } = vi.hoisted(() => ({
  openExternal: vi.fn(),
  getAppInfo: vi.fn(),
}));

vi.mock("electron", () => ({
  shell: { openExternal },
  app: { getApplicationInfoForProtocol: getAppInfo },
}));

import { PlaybackDispatcher } from "./playback-dispatcher";
import { ProtocolDetector } from "./protocol-detector";

beforeEach(() => {
  openExternal.mockReset();
  getAppInfo.mockReset();
});

describe("PlaybackDispatcher", () => {
  it("returns client_unavailable when protocol not registered", async () => {
    getAppInfo.mockResolvedValue(null);
    const d = new PlaybackDispatcher(new ProtocolDetector());
    const r = await d.dispatch("song", "123");
    expect(r).toEqual({
      state: "client_unavailable",
      resourceType: "song",
      resourceId: "123",
      errorCode: "E_PROTOCOL_NOT_REGISTERED",
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("builds orpheus:// base64-json URL and dispatches", async () => {
    getAppInfo.mockResolvedValue({ path: "x" });
    openExternal.mockResolvedValue(undefined);
    const d = new PlaybackDispatcher(new ProtocolDetector());
    const r = await d.dispatch("playlist", "456");
    expect(r.state).toBe("dispatched");
    expect(r.resourceType).toBe("playlist");
    expect(r.resourceId).toBe("456");
    expect(openExternal).toHaveBeenCalledTimes(1);
    const url = openExternal.mock.calls[0][0] as string;
    expect(url.startsWith("orpheus://")).toBe(true);
    const b64 = url.slice("orpheus://".length);
    const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    expect(decoded).toEqual({ type: "playlist", id: "456", cmd: "play" });
  });

  it("returns launch_failed and invalidates cache when openExternal throws", async () => {
    getAppInfo.mockResolvedValue({ path: "x" });
    openExternal.mockRejectedValue(new Error("nope"));
    const pd = new ProtocolDetector();
    const d = new PlaybackDispatcher(pd);
    const r = await d.dispatch("song", "1");
    expect(r.state).toBe("launch_failed");
    expect(r.errorCode).toBe("E_OPEN_EXTERNAL_FAILED");
    expect(pd["cache"]).toBeNull();
  });
});