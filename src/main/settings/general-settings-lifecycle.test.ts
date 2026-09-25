import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneralSettings } from "./general-settings";
import type { WindowManager } from "../windows/window-manager";
import { applyGeneralSettings, handleGeneralSettingsChanged } from "./general-settings-lifecycle";
import { syncLaunchAtLogin } from "./launch-at-login";

vi.mock("electron", () => ({ app: {}, nativeImage: {} }));
vi.mock("../windows/broadcast", () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock("../windows/window-state", () => ({ setGetCurrentAppIconPath: vi.fn() }));
vi.mock("../locale-context", () => ({ updateLocaleContext: vi.fn() }));
vi.mock("../orchestrator/mcp-manager", () => ({
  addMcpServer: vi.fn(), listMcpServers: () => [], removeMcpServer: vi.fn(),
}));
vi.mock("../app-icon", () => ({ getAppIconPath: vi.fn() }));
vi.mock("../orchestrator/tools/registry/tool-registration", () => ({ syncBuiltInToolToggles: vi.fn() }));
vi.mock("./model-settings", () => ({ loadModelSettings: vi.fn(), getPublicModelConfig: vi.fn() }));
vi.mock("./launch-at-login", () => ({ syncLaunchAtLogin: vi.fn() }));

function createHarness(petVisible = true) {
  const settings = {
    petVisible, petAlwaysOnTop: true, petZoom: 1, petIdleMotionsEnabled: false, launchAtLogin: false,
    asrEngine: "off", searchEngine: "off",
  } as GeneralSettings;
  let visible = petVisible;
  const windowManager = {
    showPetWindow: vi.fn(() => { visible = true; }),
    hidePetWindow: vi.fn(() => { visible = false; }),
    setPetWindowAlwaysOnTop: vi.fn(),
    applyPetWindowZoom: vi.fn(),
    sendToPetWindow: vi.fn(),
  };
  const deps = {
    windowManager: windowManager as unknown as WindowManager,
    tray: null,
    screenshotService: null,
    proactiveLifecycle: { getProactiveChatService: () => null },
    broadcastToAuxWindows: vi.fn(),
  };
  return { settings, windowManager, deps, isVisible: () => visible };
}

describe("general settings window lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps a pet hidden from the tray hidden when changing ASR provider (#85)", () => {
    const h = createHarness();
    h.windowManager.hidePetWindow();
    handleGeneralSettingsChanged(h.settings, { ...h.settings, asrEngine: "aliyun" }, h.deps);
    expect(h.isVisible()).toBe(false);
    expect(h.windowManager.showPetWindow).not.toHaveBeenCalled();
    expect(h.windowManager.setPetWindowAlwaysOnTop).not.toHaveBeenCalled();
    expect(h.windowManager.applyPetWindowZoom).not.toHaveBeenCalled();
    expect(syncLaunchAtLogin).not.toHaveBeenCalled();
  });

  it("keeps a temporarily shown pet visible when unrelated settings are saved", () => {
    const h = createHarness(false);
    h.windowManager.showPetWindow();
    handleGeneralSettingsChanged(h.settings, { ...h.settings, asrEngine: "local" }, h.deps);
    expect(h.isVisible()).toBe(true);
    expect(h.windowManager.hidePetWindow).not.toHaveBeenCalled();
  });

  it.each([true, false])("applies an explicit visibility change to %s", (visible) => {
    const h = createHarness(!visible);
    handleGeneralSettingsChanged(h.settings, { ...h.settings, petVisible: visible }, h.deps);
    expect(h.isVisible()).toBe(visible);
    expect(visible ? h.windowManager.showPetWindow : h.windowManager.hidePetWindow).toHaveBeenCalledOnce();
  });

  it("applies changed window preferences without revealing a hidden pet", () => {
    const h = createHarness();
    h.windowManager.hidePetWindow();
    handleGeneralSettingsChanged(h.settings, {
      ...h.settings, petAlwaysOnTop: false, petZoom: 1.5, launchAtLogin: true,
    }, h.deps);
    expect(h.isVisible()).toBe(false);
    expect(h.windowManager.setPetWindowAlwaysOnTop).toHaveBeenCalledWith(false);
    expect(h.windowManager.applyPetWindowZoom).toHaveBeenCalledWith(1.5);
    expect(syncLaunchAtLogin).toHaveBeenCalledWith(true, {});
  });

  it.each([true, false])("fully applies startup settings with petVisible=%s", (visible) => {
    const h = createHarness(visible);
    applyGeneralSettings(h.settings, h.deps);
    expect(visible ? h.windowManager.showPetWindow : h.windowManager.hidePetWindow).toHaveBeenCalledOnce();
    expect(h.windowManager.setPetWindowAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(h.windowManager.applyPetWindowZoom).toHaveBeenCalledWith(1);
    expect(h.windowManager.sendToPetWindow).toHaveBeenCalledWith("pet:idle-motions-changed", false);
    expect(syncLaunchAtLogin).toHaveBeenCalledWith(false, {});
  });
});
