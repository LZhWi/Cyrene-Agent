// Orchestrator Context Builder — post-chat 副作用（记忆写入 + Reflection）
import { memoryScheduler } from "../memory/memory-scheduler";
import type { MemoryScheduleContext } from "../memory/memory-scheduler";

export function scheduleMemoryWrite(userInput: string, assistantReply: string, context?: Partial<MemoryScheduleContext>): void {
  memoryScheduler.scheduleMemoryWrite(userInput, assistantReply, context);
}
