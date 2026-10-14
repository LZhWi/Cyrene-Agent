import type { LearnExamAnswerValue } from "../shared/learn-exam";

/** One ordered save queue. A failed latest answer remains dirty and cannot be submitted. */
export function createExamAnswerQueue(save: (id: string, answer: LearnExamAnswerValue) => Promise<boolean>) {
  const pending = new Map<string, { answer: LearnExamAnswerValue; version: number }>();
  let version = 0;
  let tail = Promise.resolve();
  function enqueue(id: string, value: { answer: LearnExamAnswerValue; version: number }) {
    const operation = tail.then(async () => {
      if (!(await save(id, value.answer))) throw new Error("答案保存失败，请重试保存后交卷。");
      if (pending.get(id)?.version === value.version) pending.delete(id);
    });
    tail = operation.catch(() => undefined);
    return operation;
  }
  return {
    set(id: string, answer: LearnExamAnswerValue) {
      const value = { answer: structuredClone(answer), version: ++version };
      pending.set(id, value);
      return enqueue(id, value);
    },
    async retry() {
      await tail;
      await Promise.all([...pending].map(([id, value]) => enqueue(id, value)));
    },
    async flush() {
      // The UI locks input before flushing; all accepted writes must complete before freezing.
      await tail;
      if (pending.size) throw new Error("尚有未保存的答案，请先点击重试保存。");
    },
  };
}
