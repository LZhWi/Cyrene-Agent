/**
 * Cline ESM Bridge
 *
 * @cline/sdk 是 ESM-only 包，但 Electron 主进程编译为 CommonJS。
 * TypeScript 的 module: "commonjs" 会把 import() 转成 require()，
 * 导致加载 ESM-only 包失败（ERR_PACKAGE_PATH_NOT_EXPORTED）。
 *
 * 本文件作为 ESM 桥接层，由 CJS 主进程通过 native import() 加载：
 *   const bridgeUrl = pathToFileURL(path.join(__dirname, "cline-esm-bridge.mjs")).href;
 *   const bridge = await nativeImport(bridgeUrl);
 *   const cline = await bridge.createClineCore(options);
 */

import { ClineCore } from "@cline/sdk";

export async function createClineCore(options) {
  return ClineCore.create(options);
}
