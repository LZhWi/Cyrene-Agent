import * as path from "node:path";
import { app } from "electron";

export interface MusicPaths {
  vendorDir?: string;
  componentDir?: string;
  runtimeDir: string;
  accountPath: string;
  resourceBaseDir: string;
}

export function resolveMusicPaths(): MusicPaths {
  const isPackaged = app.isPackaged;
  const userDataMusic = path.join(app.getPath("userData"), "music", "netease");
  // When running the smoke harness via electron <standalone-entry>, app.getAppPath()
  // returns the entry's directory (dist/main/main/music/), not the repo root. The
  // runner passes CYRENE_MUSIC_VENDOR_DIR to override the vendor location.
  let vendorDir: string | undefined;
  let componentDir: string | undefined;
  if (process.env.CYRENE_MUSIC_VENDOR_DIR) {
    vendorDir = process.env.CYRENE_MUSIC_VENDOR_DIR;
  } else if (isPackaged) {
    componentDir = path.join(process.resourcesPath, "components", "music");
  } else {
    vendorDir = path.resolve(app.getAppPath(), "vendor", "cloud-music-mcp");
  }
  return {
    vendorDir,
    componentDir,
    runtimeDir: path.join(userDataMusic, "runtime"),
    accountPath: path.join(userDataMusic, "account.enc"),
    resourceBaseDir: isPackaged ? process.resourcesPath : app.getAppPath(),
  };
}
