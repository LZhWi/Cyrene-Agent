import { describe, expect, it, vi } from "vitest";
import { createExamAnswerQueue } from "./learn-exam-answer-queue";

describe("exam answer save barrier", () => {
  it("waits for in-flight writes and the newest answer before submission", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const saved: string[] = [];
    const queue = createExamAnswerQueue(async (_id, answer) => { await gate; saved.push(String(answer.value)); return true; });
    const first = queue.set("q", { value: "old" });
    const latest = queue.set("q", { value: "new" });
    const frozen = vi.fn();
    const submit = queue.flush().then(frozen);
    await Promise.resolve(); expect(frozen).not.toHaveBeenCalled();
    release(); await Promise.all([first, latest, submit]);
    expect(saved).toEqual(["old", "new"]); expect(frozen).toHaveBeenCalledOnce();
  });
  it("blocks freezing on save failure and retains the answer for manual retry", async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const queue = createExamAnswerQueue(save);
    await expect(queue.set("q", { value: "answer" })).rejects.toThrow("保存失败");
    await expect(queue.flush()).rejects.toThrow("未保存");
    await queue.retry(); await queue.flush();
    expect(save).toHaveBeenLastCalledWith("q", { value: "answer" });
  });
  it("does not let an older failed write erase a newer successful answer", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("disk")).mockResolvedValueOnce(true);
    const queue = createExamAnswerQueue(save);
    const old = queue.set("q", { value: "old" }).catch(() => undefined);
    const current = queue.set("q", { value: "new" });
    await Promise.all([old, current]); await queue.flush();
    await queue.retry(); expect(save).toHaveBeenCalledTimes(2);
  });
});
