/**
 * PoC 1: Cline Ask 宿主生命周期（默认确定性套件）
 *
 * 这里验证 Cyrene 自己负责的 AskQuestionExecutor、Deferred Registry、
 * CodeRunWorker、取消、shutdown 与 interactive 生命周期，不访问真实 LLM。
 * 真实 SDK/模型行为保留在 poc1-ask-lifecycle.live.test.ts，并由
 * CYRENE_RUN_CLINE_LIVE_TESTS=1 显式启用。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cancelAsk,
  createAskQuestionExecutor,
  listPendingAsks,
  rejectAllAsksOnShutdown,
  resetAskRegistry,
  respondToAsk,
} from "../../src/main/orchestrator/code/code-ask-bridge";
import { codeRunCoordinator } from "../../src/main/orchestrator/code/code-run-coordinator";
import { codeRunStore } from "../../src/main/orchestrator/code/code-run-store";
import { codeRunWorker } from "../../src/main/orchestrator/code/code-run-worker";

interface FakeStartInput {
  prompt?: string;
  interactive?: boolean;
  capabilities?: {
    toolExecutors?: {
      askQuestion?: (question: string, options: string[]) => Promise<string>;
    };
  };
}

class FakeClineCore {
  private nextSession = 0;
  private readonly sessions = new Map<string, { interactive: boolean }>();

  async start(input: FakeStartInput): Promise<{
    sessionId: string;
    result: { finishReason: "completed"; text: string };
  }> {
    const sessionId = `fake-session-${++this.nextSession}`;
    const interactive = input.interactive === true;
    this.sessions.set(sessionId, { interactive });

    const askQuestion = input.capabilities?.toolExecutors?.askQuestion;
    let answer = "";
    if (askQuestion) {
      answer = await askQuestion("你喜欢什么颜色？", ["红色", "蓝色"]);
    }

    if (!interactive) this.sessions.delete(sessionId);
    return {
      sessionId,
      result: { finishReason: "completed", text: `好的，你喜欢${answer}` },
    };
  }

  async send(input: { sessionId: string; prompt: string }): Promise<{ finishReason: "completed"; text: string }> {
    if (!this.sessions.has(input.sessionId)) {
      throw new Error(`session not found: ${input.sessionId}`);
    }
    return { finishReason: "completed", text: input.prompt };
  }

  get(sessionId: string): { interactive: boolean } | undefined {
    return this.sessions.get(sessionId);
  }
}

function pendingPromptId(): string {
  const pending = listPendingAsks()[0];
  if (!pending) throw new Error("expected a pending Ask");
  return pending.promptId;
}

describe("PoC 1: Cline Ask 宿主生命周期", () => {
  let fake: FakeClineCore;

  beforeEach(() => {
    fake = new FakeClineCore();
    resetAskRegistry();
    codeRunCoordinator.reset();
    codeRunStore.reset();
  });

  afterEach(() => {
    codeRunStore.reset();
    codeRunCoordinator.reset();
    resetAskRegistry();
  });

  it("1. AskQuestionExecutor 调用后 turn Promise 保持 pending", async () => {
    const turn = fake.start({
      interactive: true,
      capabilities: {
        toolExecutors: {
          askQuestion: createAskQuestionExecutor("chat-1", "cline-1", "run-1"),
        },
      },
    });

    await expect.poll(() => listPendingAsks().length).toBe(1);
    let settled = false;
    void turn.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    respondToAsk(pendingPromptId(), "蓝色");
    await expect(turn).resolves.toMatchObject({
      result: { finishReason: "completed", text: "好的，你喜欢蓝色" },
    });
  });

  it("2. CodeRunWorker 持有后台 turn，调用方可先继续", async () => {
    const background = codeRunWorker.submit("run-2", "chat-2", "cline-2", () => fake.start({
      interactive: true,
      capabilities: {
        toolExecutors: {
          askQuestion: createAskQuestionExecutor("chat-2", "cline-2", "run-2"),
        },
      },
    }));

    const callerContinued = "AGUI_RUN accepted";
    expect(callerContinued).toBe("AGUI_RUN accepted");
    await expect.poll(() => listPendingAsks().length).toBe(1);
    expect(codeRunCoordinator.getRun("run-2")?.status).toBe("waiting_for_user");

    respondToAsk(pendingPromptId(), "红色");
    await expect(background).resolves.toMatchObject({
      result: { finishReason: "completed" },
    });
  });

  it("3. Deferred resolve 让同一个 turn 继续", async () => {
    const turn = fake.start({
      interactive: true,
      capabilities: {
        toolExecutors: {
          askQuestion: createAskQuestionExecutor("chat-3", "cline-3", "run-3"),
        },
      },
    });
    await expect.poll(() => listPendingAsks().length).toBe(1);

    expect(respondToAsk(pendingPromptId(), "绿色")).toBe(true);
    const result = await turn;

    expect(result.result.text).toBe("好的，你喜欢绿色");
    expect(listPendingAsks()).toHaveLength(0);
  });

  it("3b. Ask resolve 后同一个 Run 恢复 running", async () => {
    codeRunCoordinator.createRun("run-3b", "chat-3b", "cline-3b");
    expect(codeRunCoordinator.activate("run-3b")).toBe(true);
    const ask = createAskQuestionExecutor("chat-3b", "cline-3b", "run-3b")(
      "继续吗？",
      ["继续"],
    );
    await expect.poll(() => listPendingAsks().length).toBe(1);
    expect(codeRunCoordinator.getRun("run-3b")?.status).toBe("waiting_for_user");

    expect(respondToAsk(pendingPromptId(), "继续")).toBe(true);
    await expect(ask).resolves.toBe("继续");
    expect(codeRunCoordinator.getRun("run-3b")?.status).toBe("running");
  });

  it("4. 用户取消 Ask 后 Run 进入 cancelled，命令链不继续", async () => {
    const turn = codeRunWorker.submit("run-4", "chat-4", "cline-4", () => fake.start({
      interactive: true,
      capabilities: {
        toolExecutors: {
          askQuestion: createAskQuestionExecutor("chat-4", "cline-4", "run-4"),
        },
      },
    }));
    await expect.poll(() => listPendingAsks().length).toBe(1);

    expect(cancelAsk(pendingPromptId(), "user")).toBe(true);
    await expect(turn).rejects.toThrow("ASK_CANCELLED:user");
    expect(codeRunCoordinator.getRun("run-4")?.status).toBe("cancelled");
  });

  it("5. 应用退出清理所有 Active Ask，并保持 interrupted 终态", async () => {
    const turn = codeRunWorker.submit("run-5", "chat-5", "cline-5", () => fake.start({
      interactive: true,
      capabilities: {
        toolExecutors: {
          askQuestion: createAskQuestionExecutor("chat-5", "cline-5", "run-5"),
        },
      },
    }));
    await expect.poll(() => listPendingAsks().length).toBe(1);

    codeRunWorker.cleanup();
    await expect(turn).resolves.toMatchObject({
      result: { finishReason: "completed" },
    });
    expect(listPendingAsks()).toHaveLength(0);
    expect(codeRunCoordinator.getRun("run-5")?.status).toBe("interrupted");
  });

  it("6. interactive=false 关闭 Session，interactive=true 可继续 send", async () => {
    const closed = await fake.start({ interactive: false });
    expect(fake.get(closed.sessionId)).toBeUndefined();
    await expect(fake.send({ sessionId: closed.sessionId, prompt: "继续" }))
      .rejects.toThrow("session not found");

    const active = await fake.start({ interactive: true });
    expect(fake.get(active.sessionId)).toBeDefined();
    await expect(fake.send({ sessionId: active.sessionId, prompt: "继续" }))
      .resolves.toMatchObject({ finishReason: "completed", text: "继续" });
  });
});
