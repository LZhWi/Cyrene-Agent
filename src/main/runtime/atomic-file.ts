import * as fs from "fs";
import * as path from "path";

export function writeFileAtomicSync(filePath: string, data: string | Buffer): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
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
