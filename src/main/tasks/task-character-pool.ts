interface TaskCharacterDefinition {
  nickname: string;
  assetFileName: string;
  weight: number;
}

const ORDINARY_WEIGHT = 45 / 7;

export const TASK_CHARACTERS: readonly TaskCharacterDefinition[] = [
  { nickname: "风堇", assetFileName: "风堇.png", weight: 15 },
  { nickname: "刻律德菈", assetFileName: "刻律德菈.png", weight: 10 },
  { nickname: "长夜月", assetFileName: "长夜月.png", weight: 10 },
  { nickname: "遐蝶", assetFileName: "遐蝶.png", weight: 10 },
  { nickname: "缇宝", assetFileName: "缇宝.png", weight: 10 },
  ...["阿格莱雅", "白厄", "丹恒", "海瑟音", "那刻夏", "赛飞儿", "万敌"].map((nickname) => ({
    nickname,
    assetFileName: `${nickname}.png`,
    weight: ORDINARY_WEIGHT,
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

  acquire(conversationId: string, random: () => number = Math.random): TaskCharacterLease {
    const active = this.activeByConversation.get(conversationId) ?? new Set<string>();
    const available = TASK_CHARACTERS.filter((character) => !active.has(character.nickname));
    if (available.length === 0) throw new Error("TASK_CHARACTER_POOL_EXHAUSTED");

    const total = available.reduce((sum, character) => sum + character.weight, 0);
    let cursor = Math.min(Math.max(random(), 0), 1 - Number.EPSILON) * total;
    const selected = available.find((character) => {
      cursor -= character.weight;
      return cursor < 0;
    }) ?? available[available.length - 1];

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
