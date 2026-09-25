export function memoryCandidate(patch: Record<string, unknown> = {}) {
  return {
    layer: "L0",
    field: "preferredName",
    summary: "小林",
    importance: "medium",
    stability: "stable",
    certainty: "explicit",
    attribution: "user_explicit",
    evidenceQuotes: ["请叫我小林"],
    evidenceTurnRefs: ["T1"],
    contextSummary: "用户明确说明希望使用的称呼",
    shouldWrite: true,
    reason: "未来称呼用户时持续有用",
    forbiddenOverclaims: [],
    ...patch,
  };
}
