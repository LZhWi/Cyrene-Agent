import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPersonaService, parsePersonaStyle, personaStyleFromHost, PERSONA_STYLE_IDS } from "../plugins/companion-chat/src/persona";

describe("本地人格稳定提示词", () => {
  const root = path.resolve("plugins/companion-chat/persona");

  it("完整组合本地人格且保持在宿主单 Provider 上限内", () => {
    const persona = createPersonaService(root);
    for (const style of PERSONA_STYLE_IDS) {
      const prompt = persona.build(style);
      expect(prompt.length).toBeLessThanOrEqual(16_000);
      expect(prompt).toContain("# 昔涟系统规则");
      expect(prompt).toContain("# 昔涟 · Identity");
      expect(prompt).toContain("# 昔涟 · Soul");
      expect(prompt).toContain("# 昔涟 · 原作台词摘录");
      expect(prompt).toContain("正常情况下多用「人家」");
      expect(prompt).toContain("工具调用与任务调度规则见 `tools_system.md`");
      expect(prompt).toContain("工具阶段的具体调度");
      expect(prompt).toContain("Soul 阶段没有工具能力");
      expect(prompt).not.toContain("playwright-browser_");
      expect(prompt).toContain("只使用宿主当前明确提供的工具");
    }
  });

  it("主动轮使用纯聊天规则并截断 Soul 的工具相关尾章", () => {
    const prompt = createPersonaService(root).buildProactive();
    expect(prompt).toContain("# 系统规则（纯聊天专用）");
    expect(prompt).toContain("# 昔涟 · Soul");
    expect(prompt).toContain("# 昔涟 · 原作台词摘录");
    expect(prompt).toContain("风格：温柔・和善");
    expect(prompt).not.toContain("# 昔涟 · Identity");
    expect(prompt).not.toContain("## Live2D 与聊天文字的分工");
  });

  it("为独立 Tool 阶段提供不面向用户的严格调度规则", () => {
    const prompt = createPersonaService(root).buildTool();
    expect(prompt).toContain("你不是面向用户的聊天角色");
    expect(prompt).toContain("最终面向用户的回复由 Soul 阶段");
    expect(prompt).toContain("调用 `companion-chat_memory_search`");
    expect(prompt).toContain("稳定资料、长期偏好、约定或持续目标");
    expect(prompt).toContain("必须同时调用 `companion-chat_memory_search` 检索结构化记忆摘要与证据、调用 `companion-chat_history_search` 核对相关历史消息原文");
    expect(prompt).toContain("只要用户表达了让你“回忆……”或“想起来……”的意愿，必须调用 `companion-chat_history_search`");
    expect(prompt).toContain("调用 `companion-chat_history_search`");
    expect(prompt).not.toContain("music_present_tracks");
  });

  it("风格可选、追加指令位于稳定人格末尾，未知旧配置回落默认", () => {
    const persona = createPersonaService(root);
    expect(persona.build("02_lively")).toContain("风格：元气・活泼");
    expect(persona.build("03_healing")).toContain("风格：治愈・安心");
    expect(persona.build("04_focused")).toContain("风格：知性・认真");
    expect(persona.build("05_sweet")).toContain("风格：撒娇・黏人");
    expect(persona.build("01_default", "只用于测试的追加指令")).toMatch(/---\n\n只用于测试的追加指令$/);
    expect(parsePersonaStyle(undefined)).toBe("01_default");
    expect(parsePersonaStyle("invalid")).toBe("01_default");
  });

  it("把主程序五种内建风格映射到本地文本，custom 不额外叠加内建风格", () => {
    expect(personaStyleFromHost("default")).toBe("01_default");
    expect(personaStyleFromHost("lively")).toBe("02_lively");
    expect(personaStyleFromHost("healing")).toBe("03_healing");
    expect(personaStyleFromHost("focused")).toBe("04_focused");
    expect(personaStyleFromHost("sweet")).toBe("05_sweet");
    expect(personaStyleFromHost("custom")).toBeNull();

    const persona = createPersonaService(root);
    const base = persona.buildBase("自定义风格由主程序注入");
    expect(base).toContain("自定义风格由主程序注入");
    for (const marker of ["风格：温柔・和善", "风格：元气・活泼", "风格：治愈・安心", "风格：知性・认真", "风格：撒娇・黏人"]) {
      expect(base).not.toContain(marker);
    }
  });

  it("提供本地语气规则与最终 Soul 近端锚点", () => {
    const persona = createPersonaService(root);
    expect(persona.buildTone()).toContain("# 语气规则");
    expect(persona.buildTone()).toContain("严禁");
    expect(persona.buildTail()).toContain("[最终行为锚点]");
    expect(persona.buildTail()).toContain("完全平等");
  });
});
