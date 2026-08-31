import React from "react";
import compressingPng from "../../../assets/compressing.png";

export interface InterruptedRunNotice {
  runId: string;
  rounds: number;
  todoCount: number;
}

export interface SessionTakeoverNotice {
  sessionId: string;
}

export function FileDropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="cy-file-drop-overlay" aria-hidden="true">
      <span>松开即可添加到当前对话</span>
    </div>
  );
}

export function RunRecoveryNotices({
  interruptedRun,
  sessionTakeover,
  activeSessionId,
  isRunning,
  onResume,
  onTakeover,
}: {
  interruptedRun: InterruptedRunNotice | null;
  sessionTakeover: SessionTakeoverNotice | null;
  activeSessionId?: string;
  isRunning: boolean;
  onResume: (runId: string) => void;
  onTakeover: () => void;
}) {
  if (isRunning) return null;

  return (
    <>
      {interruptedRun && (
        <div className="cy-harness-recovery">
          <span>昔涟上次任务意外中断（已进行 {interruptedRun.rounds} 轮）。</span>
          <button type="button" onClick={() => onResume(interruptedRun.runId)}>继续任务</button>
        </div>
      )}
      {sessionTakeover?.sessionId === activeSessionId && (
        <div className="cy-harness-recovery">
          <span>当前会话有正在运行的任务（可能来自刷新前），本轮消息尚未执行。</span>
          <button type="button" onClick={onTakeover}>终止并重开</button>
        </div>
      )}
    </>
  );
}

export function ContextCompressionNotice({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="cy-compressing-context" aria-live="polite" aria-busy="true">
      <img src={compressingPng} className="cy-compressing-context-icon" alt="" aria-hidden="true" />
      <span>昔涟正在压缩上下文…</span>
    </div>
  );
}
