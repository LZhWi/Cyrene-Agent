import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

export function writeFileAtomicSync(filePath: string, data: string | Buffer): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, "w");
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore cleanup error */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup error */ }
    throw error;
  }
}

export function writeJsonAtomicSync(filePath: string, value: unknown): void {
  writeFileAtomicSync(filePath, JSON.stringify(value, null, 2));
}

export async function writeFileAtomic(filePath: string, data: string | Buffer): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(tempPath, "w");
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* ignore cleanup error */ }
    }
    try { await fs.promises.unlink(tempPath); } catch { /* ignore cleanup error */ }
    throw error;
  }
}
