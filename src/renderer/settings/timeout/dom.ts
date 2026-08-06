// Timeout 面板 DOM 引用
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const timeoutSaveStatus = document.getElementById("timeout-save-status") as HTMLElement;
export const timeoutSummaryInput = document.getElementById("timeout-summary") as HTMLInputElement;
export const timeoutSummaryReset = document.getElementById("timeout-summary-reset-btn") as HTMLButtonElement;
export const timeoutVisionInput = document.getElementById("timeout-vision") as HTMLInputElement;
export const timeoutVisionReset = document.getElementById("timeout-vision-reset-btn") as HTMLButtonElement;
export const timeoutUserChoiceInput = document.getElementById("timeout-user-choice") as HTMLInputElement;
export const timeoutUserChoiceReset = document.getElementById("timeout-user-choice-reset-btn") as HTMLButtonElement;
export const timeoutTestInput = document.getElementById("timeout-test") as HTMLInputElement;
export const timeoutTestReset = document.getElementById("timeout-test-reset-btn") as HTMLButtonElement;
export const timeoutMemoryJudgeInput = document.getElementById("timeout-memory-judge") as HTMLInputElement;
export const timeoutMemoryJudgeReset = document.getElementById("timeout-memory-judge-reset-btn") as HTMLButtonElement;
export const timeoutProfileTotalBudgetInput = document.getElementById("timeout-profile-total-budget") as HTMLInputElement;
export const timeoutProfileTotalBudgetReset = document.getElementById("timeout-profile-total-budget-reset-btn") as HTMLButtonElement;
export const timeoutProfilePerAttemptInput = document.getElementById("timeout-profile-per-attempt") as HTMLInputElement;
export const timeoutProfilePerAttemptReset = document.getElementById("timeout-profile-per-attempt-reset-btn") as HTMLButtonElement;
export const timeoutProfileRemainingInput = document.getElementById("timeout-profile-remaining") as HTMLInputElement;
export const timeoutProfileRemainingReset = document.getElementById("timeout-profile-remaining-reset-btn") as HTMLButtonElement;
