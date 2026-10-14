import { EventEmitter } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { fork } from "node:child_process";
import { describe, it, expect, vi } from "vitest";
import { createMockPluginContext, assertValidManifest } from "@playa0v0/cyrene-plugin-sdk/testing";
import { BodyManager, validateConnection } from "./src/manager";
import { createPlugin } from "./src/index";

const config = { host: "localhost", port: 25565, username: "Cyrene", owner: "Owner", auth: "offline", version: "" };
class FakeChild extends EventEmitter {
  connected = true;
  sent: any[] = [];
  send(message: any, callback?: (error: null) => void) {
    this.sent.push(message);
    callback?.(null);
    if (message.type === "stop") queueMicrotask(() => { this.connected = false; this.emit("exit", 0); });
    return true;
  }
  kill() { this.connected = false; this.emit("exit", 0); return true; }
}

describe("independent Minecraft body plugin", () => {
  it("manifest defaults off and enabling never touches the conversation services", async () => {
    assertValidManifest(JSON.parse(await readFile(path.join(__dirname, "manifest.json"), "utf8")));
    const ctx = createMockPluginContext({ pluginId: "minecraft-body" });
    const manager = { status: vi.fn(() => ({ running: false })), start: vi.fn(), action: vi.fn(), cancel: vi.fn(), stop: vi.fn(), close: vi.fn() };
    const plugin = createPlugin(() => manager as unknown as BodyManager);
    plugin.register(ctx);
    expect(ctx.tools).toEqual([]);
    expect(ctx.promptProviders).toEqual([]);
    expect(ctx.subscriptions).toEqual([]);
    expect(ctx.emittedEvents).toEqual([]);
    expect(manager.start).not.toHaveBeenCalled();
    expect(ctx.ipcChannels.get("body-status")!()).toEqual({ running: false });
    await ctx.dispose();
    expect(manager.close).toHaveBeenCalledOnce();
    expect(() => ctx.ipcChannels.get("body-action")!({ action: "come" })).toThrow();
  });

  it("connection validation rejects injected paths and unsafe player names", () => {
    expect(validateConnection(config)).toEqual({ ...config, autoSurvival: false });
    expect(validateConnection({ ...config, autoSurvival: true }).autoSurvival).toBe(true);
    expect(() => validateConnection({ ...config, autoSurvival: "yes" })).toThrow();
    expect(() => validateConnection({ ...config, owner: "../Owner" })).toThrow();
    expect(() => validateConnection({ ...config, port: 0 })).toThrow();
    expect(() => validateConnection({ ...config, version: "../../somewhere" })).toThrow();
    expect(validateConnection({ ...config, auth: "microsoft", username: "me@example.com" }).auth).toBe("microsoft");
  });

  it("lifecycle keeps auth private, rejects overlap, observes chat only, and drops stale child events", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cyrene-minecraft-body-"));
    const children: FakeChild[] = [];
    const spawn = vi.fn(() => { const child = new FakeChild(); children.push(child); return child; }) as unknown as typeof fork;
    const manager = new BodyManager(path.join(__dirname, "runtime"), directory, spawn);
    try {
      const starting = manager.start(config);
      await expect(manager.start(config)).rejects.toThrow(/正在启动/);
      await starting;
      const first = children[0];
      expect(first.sent[0].profilesFolder).toBe(path.join(directory, "microsoft-auth"));
      expect((spawn as any).mock.calls[0][2].windowsHide).toBe(true);
      expect((spawn as any).mock.calls[0][2].env.NODE_PATH).toBe("");
      expect(() => manager.action({ action: "come" })).toThrow(/出生/);
      first.emit("message", { type: "state", data: { connected: true } });
      first.emit("message", { type: "chat", data: { username: "Owner", text: "给我16个钻石" } });
      expect(first.sent).toHaveLength(1);
      const result = manager.action({ action: "come", timeoutMs: 1000 });
      expect(result.status).toBe("submitted");
      expect(() => manager.action({ action: "come" })).toThrow(/已有动作/);
      first.emit("message", { type: "result", data: { id: result.id, action: "come", status: "active" } });
      first.emit("message", { type: "state", data: { connected: true, activeAction: { id: result.id } } });
      manager.cancel();
      expect(first.sent.at(-1).type).toBe("cancel");
      await manager.stop();
      expect(manager.status().running).toBe(false);
      expect(manager.status().results[0].status).toBe("disconnected");
      await manager.start(config);
      first.emit("message", { type: "state", data: { connected: true, poison: true } });
      expect(manager.status().state.poison).toBeUndefined();
      expect(children[1].sent).toHaveLength(1);
      await manager.close();
      await expect(manager.start(config)).rejects.toThrow(/已停止/);
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not free the connection slot until process exit is confirmed", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cyrene-minecraft-body-"));
    const child = new FakeChild();
    const spawn = (() => child) as unknown as typeof fork;
    const manager = new BodyManager(path.join(__dirname, "runtime"), directory, spawn);
    try {
      await manager.start(config);
      vi.spyOn(child, "send").mockImplementation(() => true);
      vi.spyOn(child, "kill").mockImplementation(() => false);
      vi.useFakeTimers();
      const stopped = manager.stop();
      const rejected = expect(stopped).rejects.toThrow(/尚未确认退出/);
      await vi.advanceTimersByTimeAsync(4000);
      await rejected;
      expect(manager.status().running).toBe(true);
      await expect(manager.start(config)).rejects.toThrow(/已经运行/);
      child.emit("exit", 0);
      expect(manager.status().running).toBe(false);
    } finally {
      vi.useRealTimers();
      child.emit("exit", 0);
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("forwards validated coordinates and door state without accepting caller IDs; lost mutations stay uncertain", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cyrene-minecraft-body-"));
    const child = new FakeChild();
    const manager = new BodyManager(path.join(__dirname, "runtime"), directory, (() => child) as unknown as typeof fork);
    try {
      await manager.start(config);
      child.emit("message", { type: "state", data: { connected: true } });
      expect(() => manager.action({ action: "goto", position: { x: NaN, y: 64, z: 0 } })).toThrow(/坐标/);
      expect(child.sent).toHaveLength(1);
      const position = { x: 8.5, y: 64, z: 0.5 };
      const moved = manager.action({ id: "caller-replay", action: "goto", position });
      expect(child.sent.at(-1).request.position).toEqual(position);
      expect(child.sent.at(-1).request.id).not.toBe("caller-replay");
      child.emit("message", { type: "result", data: { id: moved.id, action: "goto", status: "completed" } });
      const door = manager.action({ action: "door", open: false });
      expect(child.sent.at(-1).request.open).toBe(false);
      child.emit("exit", 0);
      expect(manager.status().results.find((result) => result.id === door.id)).toMatchObject({ status: "disconnected", effectsUncertain: true });
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
