/** Headless runs must not share the active-run lock of the legacy default scope. */
export function harnessRunScope(conversationId: string | undefined, runId: string): string {
  return conversationId ?? `harness-headless:${runId}`;
}
