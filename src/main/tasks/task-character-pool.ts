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
