// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

function runningPlugin() {
  return {
    id: "example",
    name: "Example",
    version: "0.1.0",
    description: "example plugin",
    author: "Cyrene",
    entry: "index.cjs",
    apiVersion: 1,
    source: "user" as const,
    path: "C:\\plugins\\example",
    defaultEnabled: true,
    configuredEnabled: true,
    enabled: true,
    status: "running" as const,
    hasUnregister: true,
    canOpen: true,
  };
}

describe("feature plugin settings panel", () => {
  beforeEach(() => {
    document.body.innerHTML = [
      '<button id="feature-plugins-rescan"></button>',
      '<button id="feature-plugins-import"></button>',
      '<div id="feature-plugins-list"></div>',
    ].join("");
    vi.resetModules();
  });

  it("renders runtime state/source and opens a running plugin", async () => {
    const open = vi.fn(async () => ({ ok: true }));
    const api = {
      list: async () => ({ plugins: [runningPlugin()], issues: [] }),
      setEnabled: vi.fn(async () => ({ ok: true })),
      open,
      rescan: vi.fn(async () => ({ plugins: [runningPlugin()], issues: [] })),
      importZip: vi.fn(async () => ({ ok: false, canceled: true })),
      uninstall: vi.fn(async () => ({ ok: true })),
    };
    const { renderFeaturePlugins } = await import("./panel");

    await renderFeaturePlugins(api);
    const buttons = Array.from(document.querySelectorAll("button"));
    expect(document.body.textContent).toContain("Example v0.1.0 · 运行中");
    expect(document.body.textContent).toContain("用户插件 · API v1");
    expect(buttons.map((button) => button.textContent)).toContain("打开");

    buttons.find((button) => button.textContent === "打开")!.click();
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("example"));
  });

  it("shows persistent activation and scan errors", async () => {
    const api = {
      list: async () => ({
        plugins: [{
          ...runningPlugin(),
          enabled: false,
          status: "failed" as const,
          error: "register exploded",
        }],
        issues: [{
          root: "C:\\plugins",
          path: "C:\\plugins\\broken",
          source: "user" as const,
          message: "version 必须是合法 SemVer",
        }],
      }),
      setEnabled: vi.fn(async () => ({ ok: false, error: "still broken" })),
      open: vi.fn(async () => ({ ok: true })),
      rescan: vi.fn(async () => ({ plugins: [], issues: [] })),
      importZip: vi.fn(async () => ({ ok: false, canceled: true })),
      uninstall: vi.fn(async () => ({ ok: true })),
    };
    const { renderFeaturePlugins } = await import("./panel");
    await renderFeaturePlugins(api);
    expect(document.body.textContent).toContain("错误：register exploded");
    expect(document.body.textContent).toContain("version 必须是合法 SemVer");
    expect(document.body.textContent).toContain("重试");
    const toggle = document.querySelector<HTMLInputElement>(".switch input[type=checkbox]");
    expect(toggle).not.toBeNull();
    expect(toggle!.checked).toBe(true);
  });

  it("rescan button refreshes plugins without restarting", async () => {
    const api = {
      list: vi.fn(async () => ({ plugins: [runningPlugin()], issues: [] })),
      setEnabled: vi.fn(async () => ({ ok: true })),
      open: vi.fn(async () => ({ ok: true })),
      rescan: vi.fn(async () => ({ plugins: [runningPlugin()], issues: [] })),
      importZip: vi.fn(async () => ({ ok: false, canceled: true })),
      uninstall: vi.fn(async () => ({ ok: true })),
    };
    const { renderFeaturePlugins } = await import("./panel");
    await renderFeaturePlugins(api);
    document.querySelector<HTMLButtonElement>("#feature-plugins-rescan")!.click();
    await vi.waitFor(() => expect(api.rescan).toHaveBeenCalledTimes(1));
  });

  it("imports a ZIP and refreshes the plugin list", async () => {
    const importZip = vi.fn(async () => ({
      ok: true,
      plugin: { id: "example", name: "Example", version: "0.1.0" },
    }));
    const api = {
      list: vi.fn()
        .mockResolvedValueOnce({ plugins: [], issues: [] })
        .mockResolvedValueOnce({ plugins: [runningPlugin()], issues: [] }),
      setEnabled: vi.fn(async () => ({ ok: true })),
      open: vi.fn(async () => ({ ok: true })),
      rescan: vi.fn(async () => ({ plugins: [], issues: [] })),
      importZip,
      uninstall: vi.fn(async () => ({ ok: true })),
    };
    const { renderFeaturePlugins } = await import("./panel");
    await renderFeaturePlugins(api);

    document.querySelector<HTMLButtonElement>("#feature-plugins-import")!.click();

    await vi.waitFor(() => expect(importZip).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Example v0.1.0"));
  });

  it("renders a useful error when the plugin list cannot be loaded", async () => {
    const api = {
      list: async () => { throw new Error("IPC unavailable"); },
      setEnabled: vi.fn(async () => ({ ok: true })),
      open: vi.fn(async () => ({ ok: true })),
      rescan: vi.fn(async () => ({ plugins: [], issues: [] })),
      importZip: vi.fn(async () => ({ ok: false, canceled: true })),
      uninstall: vi.fn(async () => ({ ok: true })),
    };
    const { renderFeaturePlugins } = await import("./panel");

    await renderFeaturePlugins(api);
    expect(document.body.textContent).toContain("插件列表加载失败：IPC unavailable");
  });

  it("asks for confirmation and uninstalls only user plugins", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const uninstall = vi.fn(async () => ({ ok: true }));
    const builtin = { ...runningPlugin(), id: "builtin", name: "Builtin", source: "builtin" as const };
    const api = {
      list: vi.fn()
        .mockResolvedValueOnce({ plugins: [runningPlugin(), builtin], issues: [] })
        .mockResolvedValueOnce({ plugins: [builtin], issues: [] }),
      setEnabled: vi.fn(async () => ({ ok: true })),
      open: vi.fn(async () => ({ ok: true })),
      rescan: vi.fn(async () => ({ plugins: [], issues: [] })),
      importZip: vi.fn(async () => ({ ok: false, canceled: true })),
      uninstall,
    };
    const { renderFeaturePlugins } = await import("./panel");
    await renderFeaturePlugins(api);

    const uninstallButtons = Array.from(document.querySelectorAll("button"))
      .filter((button) => button.textContent === "卸载");
    expect(uninstallButtons).toHaveLength(1);
    uninstallButtons[0].click();

    await vi.waitFor(() => expect(uninstall).toHaveBeenCalledWith("example"));
    expect(window.confirm).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("Example v0.1.0"));
  });
});
