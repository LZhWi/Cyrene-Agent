import * as fs from "fs";
import * as path from "path";
import { enqueueLLMTask } from "../llm-queue";
import { getUserDataDir } from "../runtime/runtime-paths";
import { memoryJudge } from "./memory-judge";
import { memoryStore } from "./memory-store";
import type { MemoryFacets } from "./memory-facets";
import type { L2Memory } from "./memory-types";

const BATCH_SIZE = 12;
const MARKER_NAME = ".memory-kind-backfill-v2.json";
let activeBackfill: Promise<MemoryFacetBackfillResult> | null = null;

interface BackfillMarker {
  version: 2;
  complete: boolean;
  completedL2Ids: string[];
  updatedAt: number;
}

export interface MemoryFacetBackfillResult {
  complete: boolean;
  classifiedL2: number;
  reason?: "already_complete" | "batch_failed";
}

export function selectMemoryFacetBackfillTargets(
  l2: L2Memory[],
  markerComplete: boolean,
  completedL2Ids: string[],
): L2Memory[] {
  if (markerComplete) {
    return l2.filter((item) => !item.facets || item.facets.pendingClassification || item.facets.source === "pending");
  }
  const completed = new Set(completedL2Ids);
  return l2.filter((item) => !completed.has(item.id));
}

function readMarker(filePath: string): BackfillMarker {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<BackfillMarker>;
    return {
      version: 2,
      complete: parsed.complete === true,
      completedL2Ids: Array.isArray(parsed.completedL2Ids)
        ? parsed.completedL2Ids.filter((id): id is string => typeof id === "string")
        : [],
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return { version: 2, complete: false, completedL2Ids: [], updatedAt: 0 };
  }
}

function writeMarker(filePath: string, marker: BackfillMarker): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify({ ...marker, updatedAt: Date.now() }), "utf8");
  fs.renameSync(tmpPath, filePath);
}

async function runMemoryFacetBackfill(): Promise<MemoryFacetBackfillResult> {
  const markerPath = path.join(getUserDataDir(), MARKER_NAME);
  const marker = readMarker(markerPath);
  let classifiedL2 = 0;
  try {
    const l2 = await memoryStore.getAllL2();
    const completed = new Set(marker.completedL2Ids);
    // v2 首次启动时重新交给模型分类全部存量 L2，使旧单标签能够获得副检索标签。
    // 完成标记写入后只检查真正处于 pending 的新增/异常条目，避免重跑已分类数据，
    // 同时让正常提取偶发未产出标签的记忆能在下次启动自愈。
    const pending = selectMemoryFacetBackfillTargets(l2, marker.complete, marker.completedL2Ids);
    if (pending.length === 0) {
      marker.complete = true;
      writeMarker(markerPath, marker);
      return { complete: true, classifiedL2: 0, reason: "already_complete" };
    }
    // complete marker 下发现的 pending 可能是已分类条目后来损坏/降级。
    // 在调用模型前先撤销其 checkpoint，确保本次失败后下次启动仍会重试。
    pending.forEach((item) => completed.delete(item.id));
    marker.completedL2Ids = [...completed];
    marker.complete = false;

    for (let start = 0; start < pending.length; start += BATCH_SIZE) {
      const batch = pending.slice(start, start + BATCH_SIZE);
      const classified = await enqueueLLMTask("MemoryKindBackfill", () => memoryJudge.classifyMemoryFacetsBatch(
        batch.map((item) => ({
          id: item.id,
          text: `${item.content}\n原始线索：${item.sourceQuote || item.triggerText || ""}`.slice(0, 1600),
          context: "L2 summary memory",
        })),
      ));
      await memoryStore.updateL2FacetsBatch(classified as Array<{ id: string; facets: MemoryFacets }>);
      classified.forEach((item) => completed.add(item.id));
      classifiedL2 += classified.length;
      marker.completedL2Ids = [...completed];
      writeMarker(markerPath, marker);
      if (classified.length !== batch.length) throw new Error("L2 kind batch returned incomplete IDs");
    }

    marker.complete = true;
    writeMarker(markerPath, marker);
    console.log(`[MemoryKindBackfill] 完成：L2 ${classifiedL2} 条`);
    return { complete: true, classifiedL2 };
  } catch (error) {
    marker.complete = false;
    try { writeMarker(markerPath, marker); } catch { /* 保留原始错误 */ }
    console.warn("[MemoryKindBackfill] 本次中止，下次启动续跑:", error);
    return { complete: false, classifiedL2, reason: "batch_failed" };
  }
}

export function backfillMemoryFacets(): Promise<MemoryFacetBackfillResult> {
  if (activeBackfill) return activeBackfill;
  activeBackfill = runMemoryFacetBackfill().finally(() => {
    activeBackfill = null;
  });
  return activeBackfill;
}
