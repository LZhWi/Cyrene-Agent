/**
 * ClineResultAdapter - Cline 事件 -> CodeRunFacts 结构化事实
 *
 * 事实来源于 NormalizedClineEvent，不从自然语言总结反推。
 * 事实优先级：hostCancelled/Interrupted > 后续可信验证 > Cline finishReason > Cline自然语言。
 */

import { NormalizedClineEvent } from "./code-event-normalizer";

export type CodeRunStatus =
  | "running"
  | "waiting_for_user"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface CommandExecutionFact {
  command: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalCost?: number;
}

export interface CodeRunFacts {
  runId: string;
  chatSessionId: string;
  clineSessionId: string;

  status: CodeRunStatus;

  commands: CommandExecutionFact[];
  usage?: TokenUsage;
  errorCode?: string;
  clineFinishReason?: string;

  /** 宿主侧取消（用户在 Ask 进行中主动取消） */
  hostCancelled: boolean;
  /** 宿主侧中断（应用退出时 rejectAllAsks） */
  hostInterrupted: boolean;
}

export class ClineResultAdapter {
  private facts: CodeRunFacts;

  constructor(runId: string, chatSessionId: string, clineSessionId: string) {
    this.facts = {
      runId,
      chatSessionId,
      clineSessionId,
      status: "running",
      commands: [],
      hostCancelled: false,
      hostInterrupted: false,
    };
  }

  /** 处理一个归一化事件 */
  ingest(event: NormalizedClineEvent): void {
    switch (event.type) {
      case "command":
        this.facts.commands.push({
          command: [event.executable, ...event.args].join(" "),
          exitCode: event.exitCode,
          stdout: event.stdout,
          stderr: event.stderr,
        });
        break;

      case "usage":
        this.facts.usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalCost: event.totalCost,
        };
        break;

      case "done":
        this.facts.clineFinishReason = event.reason;
        // 重要：宿主事实优先级高于 Cline finishReason
        // hostCancelled/hostInterrupted 由 setHostCancelled/setHostInterrupted 显式设置
        // 这里只在 host 事实未设置时才更新 status
        if (!this.facts.hostCancelled && !this.facts.hostInterrupted) {
          if (event.reason === "completed") {
            this.facts.status = "completed";
          } else if (event.reason === "aborted") {
            this.facts.status = "cancelled";
          } else if (event.reason === "error" || event.reason === "mistake_limit") {
            this.facts.status = "failed";
            this.facts.errorCode = event.reason;
          } else {
            this.facts.status = "completed"; // max_iterations 也算完成
          }
        }
        break;

      case "error":
        this.facts.errorCode = event.code;
        if (!this.facts.hostCancelled && !this.facts.hostInterrupted) {
          this.facts.status = "failed";
        }
        break;

      case "ask":
        this.facts.status = "waiting_for_user";
        break;

      case "file_candidate":
        // 文件候选不直接进 facts，由 MutationCollector 处理
        break;

      case "notice":
        // 通知事件（如 auto_compaction）暂不修改 facts
        break;
    }
  }

  /** 设置宿主侧取消（用户在 Ask 时取消） */
  setHostCancelled(): void {
    this.facts.hostCancelled = true;
    this.facts.status = "cancelled";
  }

  /** 设置宿主侧中断（应用退出） */
  setHostInterrupted(): void {
    this.facts.hostInterrupted = true;
    this.facts.status = "interrupted";
  }

  /** 获取最终 facts */
  getFacts(): CodeRunFacts {
    return { ...this.facts };
  }
}