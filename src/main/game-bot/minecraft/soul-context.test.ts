import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMinecraftPersonaViews, buildMinecraftSoulContext } from "./soul-context";

function prepare(): { root: string; appPath: string; userData: string } {
  const root = mkdtempSync(join(tmpdir(), "cyrene-mc-soul-"));
  const appPath = join(root, "app");
  const userData = join(root, "data");
  mkdirSync(join(appPath, "prompts", "styles"), { recursive: true });
  mkdirSync(join(appPath, "prompts", "worldbook"), { recursive: true });
  mkdirSync(join(appPath, "src", "main", "game-bot", "minecraft-sidecar"), { recursive: true });
  mkdirSync(join(userData, "rag-data"), { recursive: true });
  writeFileSync(join(appPath, "src", "main", "game-bot", "minecraft-sidecar", "context-retrieval-worker.cjs"),
    readFileSync(join(__dirname, "..", "minecraft-sidecar", "context-retrieval-worker.cjs"), "utf8"), "utf8");
  writeFileSync(join(appPath, "prompts", "identity.md"), "# Identity\n昔涟", "utf8");
  writeFileSync(join(appPath, "prompts", "soul.md"), [
    "# Soul", "## 存在与对话定位", "陪伴用户", "## 独立判断", "会判断风险",
    "## 六、外貌描述", "粉色头发", "## Live2D 与聊天文字的分工", "调用动作工具",
  ].join("\n"), "utf8");
  writeFileSync(join(appPath, "prompts", "system.md"), "# System\n## 回复长度\n简短\n### Live2D 动作与文字\n不要注入这段\n### 普通回复\n保持自然\n## 关于工具结果\n工具目录", "utf8");
  writeFileSync(join(appPath, "prompts", "tone-rules.md"), "# Tone\n自然说话\n严格遵循[你的生活]\n没有天气工具时不要报其他城市", "utf8");
  writeFileSync(join(appPath, "prompts", "styles", "01_default.md"), "温柔自然", "utf8");
  writeFileSync(join(appPath, "prompts", "worldbook", "test.md"), "", "utf8");
  writeFileSync(join(userData, "memory.json"), JSON.stringify({ l2: [
    { content: "用户喜欢临水的家", triggerText: "湖边建家", status: "active", createdAt: 5 },
    { content: "已经归档", status: "archived", createdAt: 10 },
  ] }), "utf8");
  writeFileSync(join(userData, "rag-data", "memory-store.json"), JSON.stringify([
    { source: "chat_history", text: "我们以后住在水边吧", createdAt: 4, metadata: { role: "user" } },
    { source: "chat_history", text: "完全无关的旧话题", createdAt: 9, metadata: { role: "assistant" } },
  ]), "utf8");
  return { root, appPath, userData };
}

describe("Minecraft read-only Soul context", () => {
  it("projects different entry and exit personas without game-irrelevant sections", () => {
    const { appPath } = prepare();
    const views = buildMinecraftPersonaViews(appPath);
    expect(views.entryPersona).toContain("独立判断");
    expect(views.entryPersona).not.toContain("Identity");
    expect(views.entryPersona).not.toContain("粉色头发");
    expect(views.exitExpressionRules).toContain("温柔自然");
    expect(views.exitPersona).not.toContain("Live2D");
    expect(views.exitExpressionRules).not.toContain("不要注入这段");
    expect(views.exitExpressionRules).toContain("保持自然");
    expect(views.exitExpressionRules).not.toContain("[你的生活]");
  });

  it("retrieves bounded relevant data off-thread and preserves source files", async () => {
    const { appPath, userData } = prepare();
    const before = readFileSync(join(userData, "memory.json"), "utf8");
    const result = await buildMinecraftSoulContext(appPath, userData, {
      query: "找湖边建家的地方",
      gameConversation: [{ role: "user", content: "继续找水边吧" }],
      gameSummary: "之前决定住在湖边",
    });
    expect(result.version).toBe(2);
    expect(result.conversation[0]?.content).toBe("我们以后住在水边吧");
    expect(result.memories).toContain("用户喜欢临水的家");
    expect(result.memories).not.toContain("已经归档");
    expect(result.gameConversation[0]?.content).toBe("继续找水边吧");
    expect(result.gameSummary).toBe("之前决定住在湖边");
    expect(readFileSync(join(userData, "memory.json"), "utf8")).toBe(before);
  });

  it("attaches the two most recent saved session summaries, truncating long ones", async () => {
    const { appPath, userData } = prepare();
    mkdirSync(join(userData, "game-bot"), { recursive: true });
    writeFileSync(join(userData, "game-bot", "minecraft-sessions.json"), JSON.stringify([
      { id: "s1", startedAt: 1, endedAt: 2, serverLabel: "srv", players: ["Steve"], summary: "第一局探了矿洞" },
      { id: "s2", startedAt: 3, endedAt: 4, serverLabel: "srv", players: ["Steve", "Alex"], summary: "第二局盖了木屋" },
      { id: "s3", startedAt: 5, endedAt: 6, serverLabel: "srv", players: ["Alex"], summary: "第三局" + "长".repeat(500) },
    ]), "utf8");
    const result = await buildMinecraftSoulContext(appPath, userData, { query: "继续上次联机的进度" });
    expect(result.recentSessions).toHaveLength(2);
    expect(result.recentSessions[0]?.summary).toBe("第二局盖了木屋");
    expect(result.recentSessions[0]?.players).toEqual(["Steve", "Alex"]);
    expect(result.recentSessions[1]?.summary).toHaveLength(400);
  });
});
