interface TaskCharacterDefinition {
  nickname: string;
  assetFileName: string;
}

export const TASK_CHARACTERS: readonly TaskCharacterDefinition[] = [
  { nickname: "风堇", assetFileName: "风堇.png" },
  { nickname: "刻律德菈", assetFileName: "刻律德菈.png" },
  { nickname: "长夜月", assetFileName: "长夜月.png" },
  { nickname: "遐蝶", assetFileName: "遐蝶.png" },
  { nickname: "缇宝", assetFileName: "缇宝.png" },
  ...["阿格莱雅", "白厄", "丹恒", "海瑟音", "那刻夏", "赛飞儿", "万敌"].map((nickname) => ({
    nickname,
    assetFileName: `${nickname}.png`,
  })),
];

export function getGoldenDescendantNames(): readonly string[] {
  return TASK_CHARACTERS.map((character) => character.nickname);
}

export function buildGoldenDescendantsPrompt(): string {
  const names = getGoldenDescendantNames();
  return names.length === 0
    ? ""
    : [
      `可委托的黄金裔：${names.join("、")}。`,
      "复杂任务可以调用 task 委托一位黄金裔在独立上下文中处理；调用时必须在 companion_id 中明确选择一位。",
      "每位黄金裔在当前对话中最多保留一个开启的子代理上下文；再次委派给开启中的角色会自动在原上下文继续，不要另建同角色任务。",
      "需要释放角色并清空其活动上下文时先关闭该角色；关闭后旧记录仍可查看，再次委派会创建全新上下文。",
      "同一轮并行委派只读任务时必须选择不同的 companion_id；写入任务会排队串行执行。",
      "可以自然说“我让风堇先处理这部分”，不要说“派分身”；界面会同步展示你选择的黄金裔。",
    ].join("\n");
}

export interface TaskCharacterLease {
  nickname: string;
  assetFileName: string;
  release(): void;
}

/** Main-owned, per-conversation active character leases. */
export class TaskCharacterLeasePool {
  private readonly activeByConversation = new Map<string, Set<string>>();

  acquire(conversationId: string, nickname: string): TaskCharacterLease {
    const active = this.activeByConversation.get(conversationId) ?? new Set<string>();
    const selected = TASK_CHARACTERS.find((character) => character.nickname === nickname);
    if (!selected) throw new Error("TASK_COMPANION_UNKNOWN");
    if (active.has(selected.nickname)) throw new Error("TASK_COMPANION_BUSY");

    active.add(selected.nickname);
    this.activeByConversation.set(conversationId, active);
    let released = false;
    return {
      nickname: selected.nickname,
      assetFileName: selected.assetFileName,
      release: () => {
        if (released) return;
        released = true;
        active.delete(selected.nickname);
        if (active.size === 0) this.activeByConversation.delete(conversationId);
      },
    };
  }
}

export const taskCharacterLeasePool = new TaskCharacterLeasePool();
