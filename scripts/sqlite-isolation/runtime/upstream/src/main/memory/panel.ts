import { memoryStore } from "./memory-store";
import type { L0Profile, L1Profile, ReflectionLog } from "./memory-types";

export interface MemoryPanelItem {
  id: string;
  title: string;
  body: string;
  meta: string;
}

const REFLECTION_TYPE_LABEL: Record<ReflectionLog["type"], string> = {
  compression: "片段压缩",
  l0_update: "画像更新",
  l1_update: "近况更新",
};

function formatReflectionItem(log: ReflectionLog): MemoryPanelItem {
  const body = log.details ? `${log.summary}\n${log.details}` : log.summary;
  const meta = new Date(log.createdAt).toLocaleString();
  return {
    id: log.id,
    title: REFLECTION_TYPE_LABEL[log.type] ?? log.type,
    body,
    meta,
  };
}

export async function loadMemoryPanelData(): Promise<{
  l0: L0Profile;
  l1: L1Profile;
  l2: unknown[];
  reflections: MemoryPanelItem[];
}> {
  const [l0, l1, l2, reflectionLogs] = await Promise.all([
    memoryStore.getL0(),
    memoryStore.getL1(),
    memoryStore.getAllL2(),
    memoryStore.getReflectionLogs(),
  ]);

  return {
    l0,
    l1,
    l2: l2.sort((a, b) => b.createdAt - a.createdAt),
    reflections: reflectionLogs
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(formatReflectionItem),
  };
}
