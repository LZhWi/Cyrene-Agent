import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { OneBotReverseWsServer, resolveOneBotListenHost } from "./onebot-reverse-ws";

describe("OneBotReverseWsServer", () => {
  it("resolves loopback and WSL interface modes", () => {
    expect(resolveOneBotListenHost("loopback", undefined, {})).toEqual({ host: "127.0.0.1", resolvedMode: "loopback" });
    expect(resolveOneBotListenHost("wsl", undefined, {
      "vEthernet (WSL)": [{ address: "172.20.0.1", netmask: "255.255.240.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "172.20.0.1/20" }],
    })).toEqual({ host: "172.20.0.1", resolvedMode: "wsl" });
    expect(resolveOneBotListenHost("auto", undefined, {})).toEqual({ host: "127.0.0.1", resolvedMode: "loopback" });
  });

  it("requires a token when binding all interfaces", async () => {
    const server = new OneBotReverseWsServer({
      listenMode: "custom",
      customHost: "0.0.0.0",
      port: 0,
      onEvent: () => undefined,
      onClientConnected: () => undefined,
    });
    await expect(server.start()).rejects.toThrow(/Access Token/);
  });

  it("allows an unauthenticated loopback client when token is empty", async () => {
    let connected = false;
    const server = new OneBotReverseWsServer({
      listenMode: "loopback",
      port: 0,
      onEvent: () => undefined,
      onClientConnected: () => { connected = true; },
    });
    const info = await server.start();
    const socket = new WebSocket(info.url, { headers: { "X-Self-ID": "10001" } });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(connected).toBe(true);
    } finally {
      socket.terminate();
      await server.stop();
    }
  });

  it("rejects a wrong token and accepts an authenticated universal client", async () => {
    let connected = false;
    const server = new OneBotReverseWsServer({
      listenMode: "loopback",
      port: 0,
      accessToken: "secret-token",
      onEvent: () => undefined,
      onClientConnected: () => { connected = true; },
    });
    const info = await server.start();
    try {
      const wrongStatus = await new Promise<number>((resolve) => {
        const socket = new WebSocket(info.url, { headers: { Authorization: "Bearer wrong", "X-Self-ID": "10001" } });
        socket.once("unexpected-response", (_req, response) => {
          const status = response.statusCode ?? 0;
          response.resume();
          socket.terminate();
          resolve(status);
        });
        socket.once("error", () => undefined);
      });
      expect(wrongStatus).toBe(401);

      const queryOnlyStatus = await new Promise<number>((resolve) => {
        const socket = new WebSocket(`${info.url}?access_token=secret-token`, { headers: { "X-Self-ID": "10001" } });
        socket.once("unexpected-response", (_req, response) => {
          const status = response.statusCode ?? 0;
          response.resume();
          socket.terminate();
          resolve(status);
        });
        socket.once("error", () => undefined);
      });
      expect(queryOnlyStatus).toBe(401);

      const socket = new WebSocket(info.url, { headers: { Authorization: "Bearer secret-token", "X-Self-ID": "10001" } });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(connected).toBe(true);
      socket.terminate();
    } finally {
      await server.stop();
    }
  });

  it("replaces a reconnect from the same account and rejects a different account", async () => {
    const server = new OneBotReverseWsServer({
      listenMode: "loopback",
      port: 0,
      onEvent: () => undefined,
      onClientConnected: () => undefined,
    });
    const info = await server.start();
    const first = new WebSocket(info.url, { headers: { "X-Self-ID": "10001" } });
    await new Promise<void>((resolve, reject) => {
      first.once("open", resolve);
      first.once("error", reject);
    });
    try {
      const other = new WebSocket(info.url, { headers: { "X-Self-ID": "20002" } });
      const otherClose = new Promise<number>((resolve) => other.once("close", resolve));
      await new Promise<void>((resolve, reject) => {
        other.once("open", resolve);
        other.once("error", reject);
      });
      await expect(otherClose).resolves.toBe(4003);
      expect(first.readyState).toBe(WebSocket.OPEN);

      const replacement = new WebSocket(info.url, { headers: { "X-Self-ID": "10001" } });
      const firstClose = new Promise<number>((resolve) => first.once("close", resolve));
      await new Promise<void>((resolve, reject) => {
        replacement.once("open", resolve);
        replacement.once("error", reject);
      });
      await expect(firstClose).resolves.toBe(4001);
      expect(replacement.readyState).toBe(WebSocket.OPEN);
      replacement.terminate();
    } finally {
      first.terminate();
      await server.stop();
    }
  });

  it("closes a silent connection after the heartbeat deadline", async () => {
    const server = new OneBotReverseWsServer({
      listenMode: "loopback",
      port: 0,
      heartbeatTimeoutMs: 20,
      onEvent: () => undefined,
      onClientConnected: () => undefined,
    });
    const info = await server.start();
    const socket = new WebSocket(info.url, { headers: { "X-Self-ID": "10001" } });
    try {
      const closed = new Promise<number>((resolve) => socket.once("close", resolve));
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      await expect(closed).resolves.toBe(4000);
    } finally {
      socket.terminate();
      await server.stop();
    }
  });
});
