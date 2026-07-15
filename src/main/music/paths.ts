import * as path from "node:path";
import { app } from "electron";

export interface MusicPaths {
  vendorDir: string;
  runtimeDir: string;
  accountPath: string;
  resourceBaseDir: string;
}

export function resolveMusicPaths(): MusicPaths {
  const isPackaged = app.isPackaged;
  const userDataMusic = path.join(app.getPath("userData"), "music", "netease");
  const vendorDir = isPackaged
    ? path.join(process.resourcesPath, "music-mcp")
    : path.resolve(app.getAppPath(), "vendor", "cloud-music-mcp");
  return {
    vendorDir,
    runtimeDir: path.join(userDataMusic, "runtime"),
    accountPath: path.join(userDataMusic, "account.enc"),
    resourceBaseDir: isPackaged ? process.resourcesPath : app.getAppPath(),
  };
}
