import { afterAll, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { CHAT_MODULES, defaultChatModuleRoutes } from "../../shared/chat-module-routes";
const fixture = vi.hoisted(() => ({ root: "", profiles: [] as any[] }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.root } }));
vi.mock("./model-settings", () => ({ loadModelSettings: () => ({ modelProfiles: fixture.profiles }), resolveModelSettingsProfile: (x: unknown) => x }));
import { loadChatModuleRoutes, saveChatModuleRoutes, resolveChatModuleModel, withChatModuleRoutes } from "./chat-module-routes";
const original = { provider: "old", baseUrl: "https://old.invalid", apiKey: "old-secret", model: "old", explicitTransport: "openai" as const };
const parent = path.resolve("local-plugins/.test-runtime");
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, "routes-unit-"));
beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(root, "case-"));
  fixture.profiles = [{ id: "oauth", provider: "ChatGPT（OAuth）", baseUrl: "https://chatgpt-oauth.invalid/v1", apiKey: "oauth-managed", model: "gpt-6.1-sol", explicitTransport: "responses" }];
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
it("defaults without writes and rejects invalid saves without changing existing configuration", () => {
  expect(loadChatModuleRoutes()).toEqual(defaultChatModuleRoutes());
  expect(fs.readdirSync(fixture.root)).toEqual([]);
  saveChatModuleRoutes(defaultChatModuleRoutes());
  expect(() => saveChatModuleRoutes({ version: 1, routes: { tools: "bad" } })).toThrow();
  expect(loadChatModuleRoutes()).toEqual(defaultChatModuleRoutes());
});
for (const module of Object.keys(CHAT_MODULES) as Array<keyof typeof CHAT_MODULES>) {
  it(`${module}: main retains the exact input; OAuth changes only that module and never leaks old credentials`, () => {
    expect(resolveChatModuleModel(module, original)).toBe(original);
    const config = defaultChatModuleRoutes(); config.routes[module] = "oauth";
    saveChatModuleRoutes(config);
    expect(loadChatModuleRoutes()).toEqual(config);
    for (const other of Object.keys(CHAT_MODULES) as Array<keyof typeof CHAT_MODULES>) {
      const actual = resolveChatModuleModel(other, original);
      expect(actual.model).toBe(other === module ? "gpt-6.1-sol" : "old");
      expect(actual.apiKey).toBe(other === module ? "oauth-managed" : "old-secret");
    }
    for (const mode of ["work", "code", "learn"]) withChatModuleRoutes(mode, () => expect(resolveChatModuleModel(module, original)).toBe(original));
  });
}
it("snapshots in-flight routing and applies the next saved value to the next task", async () => {
  await withChatModuleRoutes("chat", async () => {
    const config = defaultChatModuleRoutes(); config.routes.tools = "oauth"; saveChatModuleRoutes(config);
    await Promise.resolve();
    expect(resolveChatModuleModel("tools", original)).toBe(original);
  });
  expect(resolveChatModuleModel("tools", original).model).toBe("gpt-6.1-sol");
});
it("scheduled Chat uses scheduled selection for both phases, without changing foreground Soul", () => {
  const config = defaultChatModuleRoutes(); config.routes.scheduled = "oauth"; saveChatModuleRoutes(config);
  withChatModuleRoutes("chat", () => {
    expect(resolveChatModuleModel("tools", original).model).toBe("gpt-6.1-sol");
    expect(resolveChatModuleModel("soul", original).model).toBe("gpt-6.1-sol");
  }, true);
  expect(resolveChatModuleModel("soul", original)).toBe(original);
  withChatModuleRoutes("chat", () => withChatModuleRoutes("chat", () => {
    expect(resolveChatModuleModel("soul", original).model).toBe("gpt-6.1-sol");
  }, true));
});
it("missing OAuth config fails explicitly rather than falling back to main", () => {
  const config = defaultChatModuleRoutes(); config.routes.tools = "oauth"; saveChatModuleRoutes(config); fixture.profiles = [];
  expect(() => resolveChatModuleModel("tools", original)).toThrow(/OAuth/);
});
it('persists independent main profile and OAuth model choices, preserving defaults and workspace modes', () => {
  fixture.profiles.push({ ...original, id: 'second', model: 'second-model' });
  const config = defaultChatModuleRoutes(); config.routes.tools = 'oauth'; config.models = { tools: 'oauth-other', soul: 'second' };
  saveChatModuleRoutes(config);
  expect(loadChatModuleRoutes()).toEqual(config);
  expect(resolveChatModuleModel('tools', original)).toMatchObject({ model: 'oauth-other', apiKey: 'oauth-managed' });
  expect(resolveChatModuleModel('soul', original)).toMatchObject({ model: 'second-model', apiKey: 'old-secret' });
  expect(resolveChatModuleModel('memory', original)).toBe(original);
  for (const mode of ['work', 'code', 'learn']) withChatModuleRoutes(mode, () => expect(resolveChatModuleModel('soul', original)).toBe(original));
  fixture.profiles.pop();
  expect(() => resolveChatModuleModel('soul', original)).toThrow('重新选择');
});
it('scheduled model choice overrides tools and soul only within the scheduled run', () => {
  const config = defaultChatModuleRoutes(); config.routes.scheduled = 'oauth'; config.models = { scheduled: 'scheduled-model' };
  saveChatModuleRoutes(config);
  withChatModuleRoutes('chat', () => {
    expect(resolveChatModuleModel('tools', original).model).toBe('scheduled-model');
    expect(resolveChatModuleModel('soul', original).model).toBe('scheduled-model');
  }, true);
  expect(resolveChatModuleModel('tools', original)).toBe(original);
});
it('persists reasoning independently without changing the inherited model or other modules', () => {
  const config = defaultChatModuleRoutes(); config.reasoning = { tools: 'high', memory: 'off' };
  saveChatModuleRoutes(config); expect(loadChatModuleRoutes()).toEqual(config);
  expect(resolveChatModuleModel('tools', original)).toMatchObject({ model: original.model, apiKey: original.apiKey, reasoning: { mode: 'on', effort: 'high' } });
  expect(resolveChatModuleModel('memory', original).reasoning).toEqual({ mode: 'off' });
  expect(resolveChatModuleModel('soul', original)).toBe(original);
  withChatModuleRoutes('work', () => expect(resolveChatModuleModel('tools', original)).toBe(original));
  config.routes.tools = 'oauth'; saveChatModuleRoutes(config);
  expect(resolveChatModuleModel('tools', original)).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { mode: 'on', effort: 'high' } });
  expect(() => saveChatModuleRoutes({ ...config, reasoning: { tools: 'bad' } })).toThrow('思考强度');
});
it('upgrades the single proactive selection in memory without rewriting old configuration', () => {
  const legacy = defaultChatModuleRoutes() as any; delete legacy.routes.proactiveDecision;
  legacy.routes.proactive = 'oauth'; legacy.models = { proactive: 'old-selected' }; legacy.reasoning = { proactive: 'high' };
  const file = path.join(fixture.root, 'chat-module-routes.json'); const raw = JSON.stringify(legacy); fs.writeFileSync(file, raw);
  const current = loadChatModuleRoutes(); expect(current.routes.proactiveDecision).toBe('oauth');
  expect(current.models?.proactiveDecision).toBe('old-selected'); expect(current.reasoning?.proactiveDecision).toBe('high');
  expect(resolveChatModuleModel('proactiveDecision', original)).toEqual(resolveChatModuleModel('proactive', original));
  expect(fs.readFileSync(file, 'utf8')).toBe(raw);
});
