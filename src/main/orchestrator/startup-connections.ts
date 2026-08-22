export interface StartupConnectionResult {
  connected: number;
  failed: number;
}

export async function connectStartupItems<T>(
  items: readonly T[],
  connect: (item: T) => Promise<unknown>,
  onFailure: (item: T, error: unknown) => void,
): Promise<StartupConnectionResult> {
  const outcomes = await Promise.all(items.map(async (item) => {
    try {
      await connect(item);
      return true;
    } catch (error) {
      onFailure(item, error);
      return false;
    }
  }));
  const connected = outcomes.filter(Boolean).length;
  return { connected, failed: outcomes.length - connected };
}
