export type TimeoutSettings = {
  perRoundTimeout: number,
  forceSummaryTimeout: number,
  chatRequestTimeout: number,
  visionTimeout: number,
  userChoiceTimeout: number,
  testTimeout: number,
}
export const DEFAULT_PER_ROUND_TIMEOUT_MS = 75_000;
export const DEFAULT_FORCE_SUMMARY_TIMEOUT_MS = 90_000;
export const DEFAULT_CHAT_REQUEST_TIMEOUT_MS = 300000; // FC 总预算：20 轮 × 推理模型 ~10-15s 需 300s 余量
export const DEFAULT_VISION_TIMEOUT_MS = 30_000;
export const DEFAULT_TIMEOUT_SETTINGS: TimeoutSettings = {
  testTimeout: 15000,
  perRoundTimeout: DEFAULT_PER_ROUND_TIMEOUT_MS,
  forceSummaryTimeout: DEFAULT_FORCE_SUMMARY_TIMEOUT_MS,
  chatRequestTimeout: DEFAULT_CHAT_REQUEST_TIMEOUT_MS,
  visionTimeout: DEFAULT_VISION_TIMEOUT_MS,
  userChoiceTimeout: 60000,
};
