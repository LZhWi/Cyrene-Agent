// L2 DMAE 工作记忆管理器 —— 思想移植自上游 DMAE V5.1（a51e6296），按本 fork 架构重写。
// 目标：给 L2 事件记忆加"活跃工作集"，让话题记忆跨 2~4 轮驻留注入、自然衰减，
// 弥补纯语义检索"换说法就召回不到 / 陈旧记忆每轮挤进来"的问题。
//
// 与世界书 DMAE（rag/worldbook.ts）的关系：参数族与状态语义对齐（activation/静默计数/
// 二次阻力衰减/阈值门控），但命中信号不同——世界书靠关键词匹配，L2 靠检索召回位次。
// 检索本身已是 content+triggerText 混合召回 + BM25 词法通道 + reranker，
// 关键词命中信号已被检索层吸收，这里不再重复做关键词匹配。
import * as fs from "fs";
import * as path from "path";
import { getUserDataDir } from "../runtime/runtime-paths";
import { memoryStore } from "./memory-store";
import { appendMemoryTrace } from "./memory-trace";
import { isL2LocallyRecallable, L2DmaeState, L2Memory } from "./memory-types";

// ── 参数（沿用上游标定值；全部集中于此，首周观察 trace 后再微调）──
export const L2_DMAE_PARAMS = {
  maxScore: 100,
  /** activation >= 此值视为活跃，进入驻留注入候选 */
  promptThreshold: 30,
  /** 活跃集最多驻留几条（在检索结果之外额外注入） */
  activeTopK: 4,
  /** 最终注入总量上限（检索 top-5 ∪ 活跃集，防上下文膨胀） */
  maxInject: 6,
  /** 用户静默衰减权重：D = α·US² + β·MS²（与世界书同款二次阻力衰减） */
  decayAlpha: 1.0,
  decayBeta: 0.2,
  /** 冷条目（Dormant/Archived）被召回时唤醒到 threshold + wakeBonus */
  wakeBonus: 5,
  /** 饱和窗口：近 N 轮内已注入过，召回奖励打折，防单条记忆刷屏涨分 */
  repeatWindow: 6,
  repeatRho: 0.5,
  /** 阈值比较容差：衰减分是浮点累加，恰在阈值上的条目不应因 1e-12 误差被判出局 */
  epsilon: 1e-6,
} as const;

/** 召回位次内在价值：位次 1 约可活跃 4 轮（36 - 1 - 4 - 9 = 22 < 30） */
export const L2_INTRINSIC_BY_RANK = [36, 8, 8, 1] as const;

/** 与 searchMemoryEntries 返回形状一致的最小条目结构 */
export interface DmaeRecallEntry {
  id: string;
  text: string;
  createdAt: number;
  score: number;
  metadata?: Record<string, unknown>;
}

function settingsPath(): string {
  return path.join(getUserDataDir(), "model-settings.json");
}

/**
 * DMAE 总开关：model-settings.json 的 memoryDmaeEnabled 字段，默认关。
 * 关闭时注入链路与改造前逐字节一致（回退方案 = 改回 false，无需删代码）。
 */
export function isL2DmaeEnabled(): boolean {
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.memoryDmaeEnabled === true;
  } catch {
    return false;
  }
}

function entryL2Id(entry: DmaeRecallEntry): string | undefined {
  const l2Id = entry.metadata?.l2Id;
  return typeof l2Id === "string" && l2Id.length > 0 ? l2Id : undefined;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(L2_DMAE_PARAMS.maxScore, value));
}

/**
 * 单轮状态演算（纯函数，不碰 I/O）：
 * - 被召回条目按位次获得内在价值奖励；冷条目（< threshold）唤醒到 threshold+wakeBonus
 * - 饱和窗口内重复注入的条目奖励乘 repeatRho，防止一条记忆把 activation 顶满
 * - 未命中条目静默计数 +1，二次阻力衰减加速遗忘
 */
export function simulateTurn(
  states: Map<string, L2DmaeState>,
  recalledL2Ids: string[],
  round: number,
  knownL2Ids?: Set<string>,
): Map<string, L2DmaeState> {
  const next = new Map<string, L2DmaeState>();
  const rankByL2Id = new Map<string, number>();
  recalledL2Ids.forEach((id, index) => {
    if (!rankByL2Id.has(id)) rankByL2Id.set(id, index);
  });

  for (const [l2Id, prev] of states) {
    // 记忆本体已删除的残留状态直接丢弃
    if (knownL2Ids && !knownL2Ids.has(l2Id)) continue;
    next.set(l2Id, evolveState(prev, rankByL2Id.get(l2Id), round));
  }

  // 首次被召回的新条目建档
  for (const [l2Id, rank] of rankByL2Id) {
    if (next.has(l2Id)) continue;
    if (knownL2Ids && !knownL2Ids.has(l2Id)) continue;
    const fresh: L2DmaeState = {
      activation: 0,
      userSilence: 0,
      modelSilence: 0,
      lastInjectedRound: -1,
      round: round - 1,
    };
    next.set(l2Id, evolveState(fresh, rank, round));
  }

  return next;
}

function evolveState(prev: L2DmaeState, rank: number | undefined, round: number): L2DmaeState {
  const params = L2_DMAE_PARAMS;
  const hit = typeof rank === "number";

  let reward = 0;
  if (hit) {
    const intrinsicIndex = Math.min(rank!, L2_INTRINSIC_BY_RANK.length - 1);
    reward = L2_INTRINSIC_BY_RANK[intrinsicIndex];
    // 饱和抑制：刚注入过的条目又召回，奖励打折（不是禁止注入，驻留靠活跃集完成）
    if (prev.lastInjectedRound >= 0 && round - prev.lastInjectedRound < params.repeatWindow) {
      reward *= params.repeatRho;
    }
  }

  const userSilence = hit ? 0 : prev.userSilence + 1;
  const modelSilence = hit ? 0 : prev.modelSilence + 1;
  const decay = params.decayAlpha * userSilence * userSilence
    + params.decayBeta * modelSilence * modelSilence;

  let activation = clampScore(prev.activation + reward - decay);
  // 唤醒：Dormant/Archived 被用户话题重新召回 → 拉回工作集（上游 wake-up 语义）
  if (hit && prev.activation < params.promptThreshold) {
    activation = Math.max(activation, params.promptThreshold + params.wakeBonus);
  }

  return {
    activation,
    userSilence,
    modelSilence,
    lastInjectedRound: prev.lastInjectedRound,
    round,
  };
}

/** L2Memory → 注入条目（供 pinned/活跃集补位，注解层按 metadata.l2Id 解析回本体） */
function toRecallEntry(l2: L2Memory): DmaeRecallEntry {
  return {
    id: l2.ragId ?? l2.id,
    text: l2.content,
    createdAt: l2.createdAt,
    score: 0,
    metadata: { l2Id: l2.id },
  };
}

/** 状态表 → 可序列化快照（沙箱展示用），按激活度降序 */
function describeStateMap(states: Map<string, L2DmaeState>): Array<{ l2Id: string; activation: number; state: "Active" | "Dormant" | "Archived" }> {
  return [...states.entries()]
    .map(([l2Id, st]) => ({
      l2Id,
      activation: Math.round(st.activation * 10) / 10,
      state: st.activation <= 0 ? "Archived" as const
        : st.activation >= L2_DMAE_PARAMS.promptThreshold - L2_DMAE_PARAMS.epsilon ? "Active" as const
        : "Dormant" as const,
    }))
    .sort((a, b) => b.activation - a.activation);
}

/**
 * 注入选择：检索结果 ∪ pinned 常驻 ∪ 活跃集 top-K，去重后截 maxInject。
 * 冲突未裁决条目不走 DMAE 补位通道（仍可由检索通道带 ⚠️ 措辞进来，与现有分档共存）。
 * 检索结果保持原序在前，DMAE 补位条目跟在后面——分档措辞层对两者一视同仁。
 */
export function selectEntries(
  recallEntries: DmaeRecallEntry[],
  allL2: L2Memory[],
  states: Map<string, L2DmaeState>,
): DmaeRecallEntry[] {
  const params = L2_DMAE_PARAMS;
  const l2ById = new Map(allL2.map((l2) => [l2.id, l2]));
  const selected: DmaeRecallEntry[] = [...recallEntries];
  const seen = new Set<string>();
  for (const entry of recallEntries) {
    const l2Id = entryL2Id(entry);
    if (l2Id) seen.add(l2Id);
  }

  const pushIfEligible = (l2Id: string): void => {
    if (seen.has(l2Id)) return;
    const l2 = l2ById.get(l2Id);
    if (!l2) return;
    if (!isL2LocallyRecallable(l2)) return;
    if (l2.conflictWith && l2.conflictWith.length > 0) return;
    seen.add(l2Id);
    selected.push(toRecallEntry(l2));
  };

  // pinned 常驻
  for (const l2 of allL2) {
    if (l2.isPinned) pushIfEligible(l2.id);
  }

  // 活跃集：activation >= threshold 按激活度降序取 top-K（含浮点容差）
  const activeIds = [...states.entries()]
    .filter(([l2Id, st]) => st.activation >= params.promptThreshold - params.epsilon && !seen.has(l2Id))
    .sort((a, b) => b[1].activation - a[1].activation)
    .slice(0, params.activeTopK)
    .map(([l2Id]) => l2Id);
  for (const l2Id of activeIds) pushIfEligible(l2Id);

  return selected.slice(0, params.maxInject);
}

class L2DmaeManager {
  private states = new Map<string, L2DmaeState>();
  private round = 0;
  private loaded = false;
  private saveTimer: NodeJS.Timeout | null = null;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const snapshot = await memoryStore.getL2DmaeSnapshot();
      this.states = new Map(Object.entries(snapshot.states ?? {}));
      this.round = typeof snapshot.round === "number" ? snapshot.round : 0;
    } catch (err) {
      // 状态文件腐坏：丢弃重建，行为回退为纯检索（与 settings 降级同理，留日志）
      console.error("[L2Dmae] 读取 DMAE 状态失败，重建为空表:", err);
      this.states = new Map();
      this.round = 0;
    }
    this.loaded = true;
  }

  /** 带状态更新的一轮：检索结果进演算 → 选出最终注入集 → 标记注入轮次 */
  async applyTurn(recallEntries: DmaeRecallEntry[], allL2: L2Memory[]): Promise<DmaeRecallEntry[]> {
    await this.ensureLoaded();
    this.round += 1;
    const recalledIds = recallEntries
      .map(entryL2Id)
      .filter((l2Id): l2Id is string => typeof l2Id === "string");
    const knownL2Ids = new Set(allL2.map((l2) => l2.id));
    this.states = simulateTurn(this.states, recalledIds, this.round, knownL2Ids);

    const selected = selectEntries(recallEntries, allL2, this.states);
    for (const entry of selected) {
      const l2Id = entryL2Id(entry);
      const st = l2Id ? this.states.get(l2Id) : undefined;
      if (st) st.lastInjectedRound = this.round;
    }

    this.scheduleSave();
    appendMemoryTrace({
      op: "l2.dmae.turn",
      layer: "L2",
      status: "ok",
      details: {
        round: this.round,
        recalled: recalledIds,
        injected: selected.map(entryL2Id).filter((id): id is string => typeof id === "string"),
        active: this.describeActiveSet(),
      },
    });
    return selected;
  }

  /**
   * 只读预览：模拟"下一轮"演算并给出选择结果与模拟后状态，不提交。
   * 供设置页对比沙箱与 trackState:false 的只读调用方使用。
   */
  async previewTurnDetailed(
    recallEntries: DmaeRecallEntry[],
    allL2: L2Memory[],
  ): Promise<{ selected: DmaeRecallEntry[]; states: Array<{ l2Id: string; activation: number; state: "Active" | "Dormant" | "Archived" }> }> {
    await this.ensureLoaded();
    const recalledIds = recallEntries
      .map(entryL2Id)
      .filter((l2Id): l2Id is string => typeof l2Id === "string");
    const knownL2Ids = new Set(allL2.map((l2) => l2.id));
    const simStates = simulateTurn(this.states, recalledIds, this.round + 1, knownL2Ids);
    return {
      selected: selectEntries(recallEntries, allL2, simStates),
      states: describeStateMap(simStates),
    };
  }

  async previewTurn(recallEntries: DmaeRecallEntry[], allL2: L2Memory[]): Promise<DmaeRecallEntry[]> {
    return (await this.previewTurnDetailed(recallEntries, allL2)).selected;
  }

  /** 沙箱展示用：当前每条被跟踪记忆的激活度（只读快照） */
  async describeStates(): Promise<Array<{ l2Id: string; activation: number; state: "Active" | "Dormant" | "Archived" }>> {
    await this.ensureLoaded();
    return describeStateMap(this.states);
  }

  private describeActiveSet(): string[] {
    return [...this.states.entries()]
      .filter(([, st]) => st.activation >= L2_DMAE_PARAMS.promptThreshold - L2_DMAE_PARAMS.epsilon)
      .sort((a, b) => b[1].activation - a[1].activation)
      .map(([l2Id, st]) => `${l2Id}:${st.activation.toFixed(0)}`);
  }

  /** 防抖落盘：状态变更后 5s 内无新变更才写 memory.json，避免每轮全量读写 */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushNow();
    }, 5000);
    this.saveTimer.unref?.();
  }

  async flushNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.loaded) return;
    try {
      await memoryStore.setL2DmaeSnapshot(Object.fromEntries(this.states), this.round);
    } catch (err) {
      console.error("[L2Dmae] DMAE 状态落盘失败（内存状态保留，下轮重试）:", err);
    }
  }

  /** 测试钩子：重置单例内存态 */
  resetForTest(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.states = new Map();
    this.round = 0;
    this.loaded = false;
  }
}

export const l2DmaeManager = new L2DmaeManager();
