// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatModuleRoutes, type ChatModuleRoutesApi } from "./ChatModuleRoutes";

let root: Root;
const host = window as unknown as { settings?: { getChatModuleRoutes: ChatModuleRoutesApi["read"]; saveChatModuleRoutes: ChatModuleRoutesApi["save"] } };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState({}, "", "/settings/index.html");
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
});
afterEach(async () => { await act(async () => root.unmount()); delete host.settings; vi.unstubAllGlobals(); });
const click = async (text: string) => act(async () => {
  const button = [...document.querySelectorAll("button")].find(x => x.textContent === text)!;
  button.click();
});
function setup() {
  let config = { version: 1 as const, routes: { soul: "main" as const, proactive: "main" as const, tools: "main" as const } };
  const save = vi.fn(async value => { config = structuredClone(value); return config; });
  host.settings = {
    getChatModuleRoutes: async () => ({ ...config, modules: { soul: "最终回复", proactive: "主动消息", tools: "工具阶段" }, mainLabel: "主模型测试", oauthLabel: "6.1" }), saveChatModuleRoutes: save,
  };
  return save;
}
it("keeps existing hosts unchanged without a routing capability", async () => {
  await act(async () => root.render(React.createElement(ChatModuleRoutes)));
  expect(document.querySelector("section")).toBeNull();
});
it("does not save on mount or selection; persists one module and restores all-main", async () => {
  const save = setup();
  await act(async () => root.render(React.createElement(ChatModuleRoutes)));
  expect(save).not.toHaveBeenCalled();
  const select = document.querySelectorAll<HTMLSelectElement>('select[aria-label$="的模型线路"]')[2];
  await act(async () => { select.value = "oauth"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(save).not.toHaveBeenCalled();
  await click("保存模块分工");
  expect(save).toHaveBeenLastCalledWith({ version: 1, routes: { soul: "main", proactive: "main", tools: "oauth" } });
  await act(async () => root.render(React.createElement(ChatModuleRoutes, { key: "reopen" })));
  expect(document.querySelectorAll<HTMLSelectElement>('select[aria-label$="的模型线路"]')[2].value).toBe("oauth");
  await click("全部由主模型负责"); await click("保存模块分工");
  expect(Object.values(save.mock.lastCall![0].routes)).toEqual(["main", "main", "main"]);
});
it("keeps an unsuccessful save editable and never reports success", async () => {
  const save = setup(); save.mockRejectedValueOnce(new Error("测试保存失败"));
  await act(async () => root.render(React.createElement(ChatModuleRoutes)));
  await click("推荐分工"); await click("保存模块分工");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("测试保存失败");
  expect(document.body.textContent).not.toContain("已保存，将用于");
  expect(document.querySelector("select")?.disabled).toBe(false);
  await click("保存模块分工");
  expect(document.body.textContent).toContain("已保存，将用于后续任务");
});
it('offers main profiles and authorized OAuth models and restores the module selection', async () => {
  const save = setup();
  const settings = host.settings! as typeof host.settings & { chatGptOAuthModels?: () => Promise<Array<{ id: string; name: string }>> };
  const read = settings!.getChatModuleRoutes;
  settings!.getChatModuleRoutes = async () => ({ ...await read(), mainProfiles: [{ id: 'api-profile', name: 'API profile' }] });
  settings!.chatGptOAuthModels = async () => [{ id: 'oauth-model', name: 'OAuth model' }];
  await act(async () => root.render(React.createElement(ChatModuleRoutes)));
  const route = document.querySelector<HTMLSelectElement>('select[aria-label="工具阶段的模型线路"]')!;
  const model = document.querySelector<HTMLSelectElement>('select[aria-label="工具阶段的指定模型"]')!;
  expect(model.textContent).toContain('API profile');
  await act(async () => { model.value = 'api-profile'; model.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('保存模块分工');
  expect(save.mock.lastCall![0].models.tools).toBe('api-profile');
  await act(async () => { route.value = 'oauth'; route.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(model.value).toBe('');
  expect(model.textContent).toContain('OAuth model');
  await act(async () => { model.value = 'oauth-model'; model.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('保存模块分工');
  await act(async () => root.render(React.createElement(ChatModuleRoutes, { key: 'reload' })));
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="工具阶段的指定模型"]')!.value).toBe('oauth-model');
});
it('keeps help collapsed until the information button is clicked', async () => {
  setup(); await act(async () => root.render(React.createElement(ChatModuleRoutes)));
  const button = document.querySelector<HTMLButtonElement>('[aria-label="模块分工说明"]')!;
  const help = document.getElementById('chat-module-help')!;
  expect(help.hidden).toBe(true);
  await act(async () => button.click());
  expect(help.hidden).toBe(false); expect(button.getAttribute('aria-expanded')).toBe('true');
  await act(async () => button.click()); expect(help.hidden).toBe(true);
});
it('saves and reloads per-module reasoning without choosing a different model', async () => {
  const save = setup(); await act(async () => root.render(React.createElement(ChatModuleRoutes)));
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="工具阶段的思考强度"]')!;
  expect(select.value).toBe('');
  await act(async () => { select.value = 'high'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(save).not.toHaveBeenCalled(); await click('保存模块分工');
  expect(save.mock.lastCall![0].reasoning).toEqual({ tools: 'high' });
  expect(save.mock.lastCall![0].models).toBeUndefined();
  await act(async () => root.render(React.createElement(ChatModuleRoutes, { key: 'reasoning-reload' })));
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="工具阶段的思考强度"]')!.value).toBe('high');
});
