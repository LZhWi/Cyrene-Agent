// 屏幕观测缓存 — 进程内存储最近 N 条观测摘要。
// 不存图片（隐私保护），只存 VLM 返回的文本摘要 + 时间戳 + 来源。

export interface ScreenObservation {
  timestamp: number;
  summary: string;
  source: "periodic" | "tool" | "trigger";
}

const MAX_OBSERVATIONS = 50;
const RETENTION_MS = 7200 * 1000; // 2 小时

/**
 * 低变化兜底阈值（仅场景类目不可用时用文本相似度兜底）。
 * 0.45 依据实测：结构化两行摘要下同场景相似度约 0.50，不同场景 0.28~0.31，
 * 取中间值。旧值 0.7 是自由摘要时代定的，结构化格式下同场景也到不了，等于兜底失效。
 * service 与 tool 共用此常量，避免两处漂移。
 */
export const LOW_CHANGE_SIMILARITY_THRESHOLD = 0.45;

export class ScreenObservationStore {
  private observations: ScreenObservation[] = [];

  add(observation: ScreenObservation): void {
    this.observations.push(observation);
    // 并发观测（工具调用与后台周期同时截图）可能乱序到达，
    // 按时间戳排序保证 getLatest/getRecent 的时序正确。
    this.observations.sort((a, b) => a.timestamp - b.timestamp);
    // 超容量删旧
    if (this.observations.length > MAX_OBSERVATIONS) {
      this.observations.shift();
    }
    // 删过期
    const cutoff = Date.now() - RETENTION_MS;
    this.observations = this.observations.filter((o) => o.timestamp > cutoff);
  }

  getRecent(count: number): ScreenObservation[] {
    const cutoff = Date.now() - RETENTION_MS;
    return this.observations
      .filter((o) => o.timestamp > cutoff)
      .slice(-count);
  }

  getLatest(): ScreenObservation | null {
    return this.observations[this.observations.length - 1] ?? null;
  }

  /** 最近一条观测是否在 maxAgeMs 内（用于缓存复用判断）。 */
  isLatestFresh(maxAgeMs: number): boolean {
    const latest = this.getLatest();
    if (!latest) return false;
    return Date.now() - latest.timestamp < maxAgeMs;
  }

  clear(): void {
    this.observations = [];
  }
}

export const observationStore = new ScreenObservationStore();

/**
 * 简单的文本相似度（字符 Jaccard 重叠率）。
 * 不需要额外依赖，用字符集交集/并集判断两条摘要是否相似。
 */
export function textSimilarity(a: string, b: string): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const ch of setA) {
    if (setB.has(ch)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}
