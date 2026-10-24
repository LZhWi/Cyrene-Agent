// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeBridge(hasAccessToken = false) {
  return {
    channelsGetConfig: vi.fn(async () => ({
      wechat: {}, feishu: {}, qqbot: {},
      qq: { enabled: true, listenMode: "auto", hasAccessToken },
    })),
    channelsGetStatus: vi.fn(async () => ({})),
    channelsLogGet: vi.fn(async () => []),
    channelsContextBindingsGet: vi.fn(async () => ({ sessions: [], conversations: [], bindings: [] })),
    channelsSaveConfig: vi.fn(async (_patch: unknown) => ({})),
    channelsRestart: vi.fn(async () => ({ ok: true })),
    channelsQqResolveAuthRequirement: vi.fn(async (_input: unknown) => ({
      ok: true, requiresAccessToken: true, resolvedHost: "172.20.0.1", resolvedMode: "wsl",
    })),
    onChannelsInstallProgress: vi.fn(),
    onChannelsStatusChanged: vi.fn(),
    onChannelsWechatQrcode: vi.fn(),
    onChannelsWechatLoginDone: vi.fn(),
  };
}

function input(id: string) { return document.getElementById(id) as HTMLInputElement; }
function save() { document.getElementById("channels-qq-save")!.click(); }
function feedback() { return document.getElementById("channels-qq-feedback")!.textContent; }

async function load(hasAccessToken = false) {
  const bridge = makeBridge(hasAccessToken);
  Object.assign(window, { settings: bridge });
  const { loadChannelsPanel } = await import("./panel");
  await loadChannelsPanel();
  return bridge;
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = `
    <div id="proactive-delivery-select"></div>
    <input id="channels-qq-enabled" type="checkbox">
    <select id="channels-qq-listen-mode">
      <option value="auto">auto</option><option value="loopback">loopback</option>
      <option value="wsl">wsl</option><option value="custom">custom</option>
    </select>
    <input id="channels-qq-custom-host"><input id="channels-qq-port">
    <input id="channels-qq-token" type="password">
    <button id="channels-qq-save">保存</button><div id="channels-qq-feedback"></div>`;
});

afterEach(() => {
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "settings");
  vi.restoreAllMocks();
});

describe("QQ 监听保存预检", () => {
  it("auto 解析为 WSL 时先生成 Token，第二次点击才保存并重连", async () => {
    const bridge = await load();
    save();
    await vi.waitFor(() => expect(input("channels-qq-token").value).toMatch(/^[0-9a-f]{64}$/));
    expect(bridge.channelsQqResolveAuthRequirement).toHaveBeenCalledWith({ listenMode: "auto", customHost: "" });
    expect(bridge.channelsSaveConfig).not.toHaveBeenCalled();
    expect(bridge.channelsRestart).not.toHaveBeenCalled();
    expect(feedback()).toContain("复制");
    const token = input("channels-qq-token").value;
    save();
    await vi.waitFor(() => expect(bridge.channelsRestart).toHaveBeenCalledTimes(1));
    expect(bridge.channelsSaveConfig).toHaveBeenCalledWith({ qq: expect.objectContaining({ listenMode: "auto", accessToken: token }) });
    expect(input("channels-qq-token").value).toBe("");
    // 已保存的 Token 不回显，也不应在下次保存时重新生成或清空。
    save();
    await vi.waitFor(() => expect(bridge.channelsRestart).toHaveBeenCalledTimes(2));
    expect(bridge.channelsSaveConfig.mock.calls.at(-1)?.[0]).toEqual({ qq: expect.not.objectContaining({ accessToken: expect.anything() }) });
  });

  it("auto 解析为回环时允许不带 Token 保存", async () => {
    const bridge = await load();
    bridge.channelsQqResolveAuthRequirement.mockResolvedValue({ ok: true, requiresAccessToken: false, resolvedHost: "127.0.0.1", resolvedMode: "loopback" });
    save();
    await vi.waitFor(() => expect(bridge.channelsRestart).toHaveBeenCalledTimes(1));
    expect(bridge.channelsSaveConfig.mock.calls[0][0]).toEqual({ qq: expect.not.objectContaining({ accessToken: expect.anything() }) });
    expect(input("channels-qq-token").value).toBe("");
  });

  it("沿用已保存的 Token，不用空输入覆盖", async () => {
    const bridge = await load(true);
    save();
    await vi.waitFor(() => expect(bridge.channelsRestart).toHaveBeenCalledTimes(1));
    expect(bridge.channelsQqResolveAuthRequirement).toHaveBeenCalledTimes(1);
    expect(bridge.channelsSaveConfig.mock.calls[0][0]).toEqual({ qq: expect.not.objectContaining({ accessToken: expect.anything() }) });
  });

  it("预检发现自定义地址为空时显示原因，不保存也不重连", async () => {
    const bridge = await load();
    input("channels-qq-listen-mode").value = "custom";
    bridge.channelsQqResolveAuthRequirement.mockResolvedValue({ ok: false, requiresAccessToken: false, error: "QQ 自定义监听地址为空" } as never);
    save();
    await vi.waitFor(() => expect(feedback()).toContain("自定义监听地址为空"));
    expect(bridge.channelsSaveConfig).not.toHaveBeenCalled();
    expect(bridge.channelsRestart).not.toHaveBeenCalled();
    expect(input("channels-qq-token").value).toBe("");
  });

  it("预检调用失败时展示错误且不保存", async () => {
    const bridge = await load();
    bridge.channelsQqResolveAuthRequirement.mockRejectedValue(new Error("网卡枚举不可用"));
    save();
    await vi.waitFor(() => expect(feedback()).toContain("网卡枚举不可用"));
    expect(bridge.channelsSaveConfig).not.toHaveBeenCalled();
    expect(bridge.channelsRestart).not.toHaveBeenCalled();
  });
});
