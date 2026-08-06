// Timeout 面板业务逻辑：超时配置加载 / 保存 / 重置按钮绑定
// 从 settings.ts 抽离。依赖 timeout DOM 引用（./dom）、api DOM 引用（../api/dom，复用 modelRequestTimeoutSec*）。
// saveTimeoutSettings 导出供 settings.ts 的 API 表单处理器调用（跨面板共享保存逻辑）。

import {
  timeoutSaveStatus,
  timeoutSummaryInput, timeoutSummaryReset,
  timeoutVisionInput, timeoutVisionReset,
  timeoutUserChoiceInput, timeoutUserChoiceReset,
  timeoutTestInput, timeoutTestReset,
  timeoutMemoryJudgeInput, timeoutMemoryJudgeReset,
  timeoutProfileTotalBudgetInput, timeoutProfileTotalBudgetReset,
  timeoutProfilePerAttemptInput, timeoutProfilePerAttemptReset,
  timeoutProfileRemainingInput, timeoutProfileRemainingReset,
} from "./dom";
import { modelRequestTimeoutSecInput, modelRequestTimeoutSecReset } from "../api/dom";
import { setSaveStatus, setTimeoutSaveStatus } from "../shared/save-status";
import { parsePositiveIntOrThrow, parseN1SecToMsOrThrow } from "../shared/parse";
import {
  DEFAULT_FORCE_SUMMARY_TIMEOUT_MS,
  DEFAULT_VISION_TIMEOUT_MS,
  DEFAULT_MEMORY_JUDGE_MS,
  type TimeoutSettings,
} from "../../../shared/timeout-types";

export async function loadTimeoutSettings(): Promise<void> {
  try {
    const cfg = await window.settings!.getTimeoutSettings();
    timeoutSummaryInput.value = String(cfg.forceSummaryTimeout);
    timeoutVisionInput.value = String(cfg.visionTimeout);
    timeoutUserChoiceInput.value = String(cfg.userChoiceTimeout / 1000);
    timeoutTestInput.value = String(cfg.testTimeout);
    timeoutMemoryJudgeInput.value = String(cfg.memoryJudgeTimeout);
    timeoutProfileTotalBudgetInput.value = cfg.profileTotalBudgetMs === -1 ? "" : String(cfg.profileTotalBudgetMs / 1000);
    timeoutProfilePerAttemptInput.value = cfg.profilePerAttemptTimeoutMs === -1 ? "" : String(cfg.profilePerAttemptTimeoutMs / 1000);
    timeoutProfileRemainingInput.value = cfg.profileMinimumRemainingBudgetMs === -1 ? "" : String(cfg.profileMinimumRemainingBudgetMs / 1000);
    modelRequestTimeoutSecInput.value = cfg.modelRequestTimeoutSec != null ? String(cfg.modelRequestTimeoutSec) : "";
    setTimeoutSaveStatus("时间设置保存后，对后续请求生效．");
  } catch {
    setTimeoutSaveStatus("读取偏好失败", "is-error");
  }
}

export async function saveTimeoutSettings(saveTestTimeout: boolean): Promise<boolean> {
  let settings: Partial<TimeoutSettings>;
  try {
    if (!saveTestTimeout) {
      settings = {
        forceSummaryTimeout: parsePositiveIntOrThrow(timeoutSummaryInput.value, "工具总结阶段 API 超时"),
        visionTimeout: parsePositiveIntOrThrow(timeoutVisionInput.value, "视觉模型单次 API 超时"),
        userChoiceTimeout: 1000 * parsePositiveIntOrThrow(timeoutUserChoiceInput.value, "工具请求确认时间限制"),
        memoryJudgeTimeout: parsePositiveIntOrThrow(timeoutMemoryJudgeInput.value, "记忆总结阶段 API 超时"),
        profileTotalBudgetMs: parseN1SecToMsOrThrow(timeoutProfileTotalBudgetInput.value, "阶段总时间预算"),
        profilePerAttemptTimeoutMs: parseN1SecToMsOrThrow(timeoutProfilePerAttemptInput.value, "单次尝试超时"),
        profileMinimumRemainingBudgetMs: parseN1SecToMsOrThrow(timeoutProfileRemainingInput.value, "最小剩余时间"),
        modelRequestTimeoutSec: modelRequestTimeoutSecInput.value === "" ? undefined : parsePositiveIntOrThrow(modelRequestTimeoutSecInput.value, "模型请求超时"),
      };
    } else {
      settings = {
        testTimeout: parsePositiveIntOrThrow(timeoutTestInput.value, "测试超时"),
      };
    }
  } catch (e) {
    if (saveTestTimeout) {
      setSaveStatus("无效输入：" + e, "is-error");
    } else {
      setTimeoutSaveStatus("无效输入：" + e, "is-error");
    }
    return false;
  }
  try {
    await window.settings!.saveTimeoutSettings(settings);
    if (saveTestTimeout) {
      setSaveStatus("已保存", "is-ok");
    } else {
      setTimeoutSaveStatus("已保存", "is-ok");
    }
    return true;
  } catch {
    if (saveTestTimeout) {
      setSaveStatus("保存失败", "is-error");
    } else {
      setTimeoutSaveStatus("保存失败", "is-error");
    }
  }
  return false;
}

// ===== 重置按钮事件绑定（模块加载时执行） =====
timeoutTestReset.addEventListener("click", () => { timeoutTestInput.value = "15000" });
timeoutSummaryReset.addEventListener("click", () => { timeoutSummaryInput.value = String(DEFAULT_FORCE_SUMMARY_TIMEOUT_MS) });
timeoutVisionReset.addEventListener("click", () => { timeoutVisionInput.value = String(DEFAULT_VISION_TIMEOUT_MS) });
timeoutMemoryJudgeReset.addEventListener("click", () => { timeoutMemoryJudgeInput.value = String(DEFAULT_MEMORY_JUDGE_MS) });
timeoutUserChoiceReset.addEventListener("click", () => { timeoutUserChoiceInput.value = "60" });

timeoutProfileTotalBudgetReset.addEventListener("click", () => { timeoutProfileTotalBudgetInput.value = "" });
timeoutProfilePerAttemptReset.addEventListener("click", () => { timeoutProfilePerAttemptInput.value = "" });
timeoutProfileRemainingReset.addEventListener("click", () => { timeoutProfileRemainingInput.value = "" });
modelRequestTimeoutSecReset.addEventListener("click", () => { modelRequestTimeoutSecInput.value = "" });

// 模块加载时拉一次配置
void loadTimeoutSettings();
