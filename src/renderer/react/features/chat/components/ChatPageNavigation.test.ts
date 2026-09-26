import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../components/ui/SidebarToggle", () => ({
  SidebarToggle: ({ collapsed }: { collapsed: boolean }) => createElement("span", null, `sidebar-toggle:${collapsed}`),
}));
vi.mock("../../../components/ui/ModeSwitch", () => ({
  ModeSwitch: ({ availableModes }: { availableModes?: readonly string[] }) => createElement("span", null, `mode-switch:${availableModes?.join(",") ?? "all"}`),
}));
vi.mock("../../../components/ui/ToolModeButton", () => ({
  ToolModeButton: ({ active }: { active: boolean }) => createElement("span", null, `tool-button:${active}`),
}));
vi.mock("../../../components/ui/SkillModeButton", () => ({
  SkillModeButton: () => createElement("span", null, "skill-button"),
}));
vi.mock("../../../components/ui/ModelModeButton", () => ({
  ModelModeButton: () => createElement("span", null, "model-button"),
}));
vi.mock("../../../components/ui/PluginModeButton", () => ({
  PluginModeButton: ({ active }: { active: boolean }) => createElement("span", null, `plugin-button:${active}`),
}));
vi.mock("../../../components/ui/WindowControls", () => ({
  WindowControls: () => createElement("span", null, "window-controls"),
}));
vi.mock("../../../components/ui/SettingsButton", () => ({
  SettingsButton: () => createElement("span", null, "settings-button"),
}));
vi.mock("../../../components/ui/UserAvatar", () => ({ UserAvatar: () => createElement("span", null, "user-avatar") }));
vi.mock("../../../components/ui/NewTaskButton", () => ({
  NewTaskButton: () => createElement("span", null, "new-task-button"),
}));
vi.mock("./AppUpdateEntry", () => ({ AppUpdateEntry: () => createElement("span", null, "app-update-entry") }));
vi.mock("./ConversationSidebar", () => ({
  ConversationSidebar: () => createElement("span", null, "conversation-sidebar"),
}));

import { ChatPageNavigation } from "./ChatPageNavigation";

describe("ChatPageNavigation", () => {
  it("shows only Chat in the companion window and only tool modes in the workspace window", () => {
    const props = {
      collapsed: false,
      activePanel: null,
      sessions: [],
      onToggleCollapsed: () => undefined,
      onModeChange: () => undefined,
      onNewTask: () => undefined,
      onTogglePanel: () => undefined,
      onSelectSession: () => undefined,
      onOpenProject: () => undefined,
      onRenameSession: () => undefined,
      onDeleteSession: () => undefined,
      onTogglePinSession: () => undefined,
      onMinimize: () => undefined,
      onMaximize: () => undefined,
      onCloseWindow: () => undefined,
      onOpenSettings: () => undefined,
    } as const;
    expect(renderToStaticMarkup(createElement(ChatPageNavigation, { ...props, mode: "chat", windowKind: "chat" })))
      .toContain("mode-switch:chat");
    const workspace = renderToStaticMarkup(createElement(ChatPageNavigation, { ...props, mode: "work", windowKind: "workspace" }));
    expect(workspace).toContain("mode-switch:work,code,learn");
    expect(workspace).not.toContain("tool-button");
    expect(workspace).not.toContain("plugin-button");
  });

  it("renders a dedicated titlebar drag region", () => {
    const html = renderToStaticMarkup(createElement(ChatPageNavigation, {
      collapsed: false,
      activePanel: null,
      mode: "chat",
      sessions: [],
      activeSessionId: undefined,
      onToggleCollapsed: () => undefined,
      onModeChange: () => undefined,
      onNewTask: () => undefined,
      onTogglePanel: () => undefined,
      onSelectSession: () => undefined,
      onOpenProject: () => undefined,
      onRenameSession: () => undefined,
      onDeleteSession: () => undefined,
      onTogglePinSession: () => undefined,
      onMinimize: () => undefined,
      onMaximize: () => undefined,
      onCloseWindow: () => undefined,
      onOpenSettings: () => undefined,
    }));

    expect(html).toContain('class="cy-page-drag-region"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("hides the mode switch while a tool panel is open", () => {
    const html = renderToStaticMarkup(createElement(ChatPageNavigation, {
      collapsed: false,
      activePanel: "tool",
      mode: "chat",
      sessions: [],
      activeSessionId: undefined,
      onToggleCollapsed: () => undefined,
      onModeChange: () => undefined,
      onNewTask: () => undefined,
      onTogglePanel: () => undefined,
      onSelectSession: () => undefined,
      onOpenProject: () => undefined,
      onRenameSession: () => undefined,
      onDeleteSession: () => undefined,
      onTogglePinSession: () => undefined,
      onMinimize: () => undefined,
      onMaximize: () => undefined,
      onCloseWindow: () => undefined,
      onOpenSettings: () => undefined,
    }));

    expect(html).not.toContain("mode-switch");
    expect(html).toContain("tool-button:true");
    expect(html).toContain("conversation-sidebar");
  });

  it("places the plugin entry after the model entry and marks it active", () => {
    const html = renderToStaticMarkup(createElement(ChatPageNavigation, {
      collapsed: false,
      activePanel: "plugin",
      mode: "chat",
      sessions: [],
      activeSessionId: undefined,
      onToggleCollapsed: () => undefined,
      onModeChange: () => undefined,
      onNewTask: () => undefined,
      onTogglePanel: () => undefined,
      onSelectSession: () => undefined,
      onOpenProject: () => undefined,
      onRenameSession: () => undefined,
      onDeleteSession: () => undefined,
      onTogglePinSession: () => undefined,
      onMinimize: () => undefined,
      onMaximize: () => undefined,
      onCloseWindow: () => undefined,
      onOpenSettings: () => undefined,
    }));

    expect(html.indexOf("model-button")).toBeLessThan(html.indexOf("plugin-button:true"));
    expect(html).not.toContain("mode-switch");
  });

  it("shows companion life status only beside the Chat mode switch", () => {
    const props = {
      collapsed: false,
      activePanel: null,
      sessions: [],
      activeSessionId: undefined,
      companionLifeStatus: { text: "正在读书", resting: false },
      onToggleCollapsed: () => undefined,
      onModeChange: () => undefined,
      onNewTask: () => undefined,
      onTogglePanel: () => undefined,
      onSelectSession: () => undefined,
      onOpenProject: () => undefined,
      onRenameSession: () => undefined,
      onDeleteSession: () => undefined,
      onTogglePinSession: () => undefined,
      onMinimize: () => undefined,
      onMaximize: () => undefined,
      onCloseWindow: () => undefined,
      onOpenSettings: () => undefined,
    };
    const chat = renderToStaticMarkup(createElement(ChatPageNavigation, { ...props, mode: "chat" }));
    const work = renderToStaticMarkup(createElement(ChatPageNavigation, { ...props, mode: "work" }));
    expect(chat).toContain("昔涟 · 正在读书");
    expect(chat).toContain("🌸");
    expect(chat).toContain('class="cy-chat-topfade"');
    expect(work).not.toContain("正在读书");
    expect(work).not.toContain('class="cy-chat-topfade"');
  });
});
