import * as fs from "node:fs";

const RETRY_DELAYS_MS = [1, 2, 4, 8];
const waitArray = new Int32Array(new SharedArrayBuffer(4));

/** 保留同步落盘语义；文件暂时被占用时最多等待 15ms，不删除旧文件。 */
export function renameWithRetrySync(source: string, target: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= RETRY_DELAYS_MS.length || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) {
        throw error;
      }
      Atomics.wait(waitArray, 0, 0, RETRY_DELAYS_MS[attempt]);
    }
  }
}
