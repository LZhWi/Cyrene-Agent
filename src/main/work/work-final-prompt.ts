export function buildWorkFinalSystemPrompt(workPrompt: string, stylePrompt: string): string {
  return [workPrompt.trim(), stylePrompt.trim()].filter(Boolean).join("\n\n---\n\n");
}
