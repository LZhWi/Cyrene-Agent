import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

// 通用构建仅通过此变量把专用脚本的输出导向本次暂存目录。
export async function getArtifactRoot(root) {
  const artifacts = path.join(await realpath(root), "artifacts");
  await mkdir(artifacts, { recursive: true });
  if (await realpath(artifacts) !== artifacts) throw new Error("artifacts 目录不能是链接");
  const override = process.env.CYRENE_PLUGIN_ARTIFACTS_ROOT;
  if (!override) return artifacts;
  const output = path.resolve(override);
  if (path.dirname(output) !== artifacts || !/^\.build-[a-zA-Z0-9-]+$/.test(path.basename(output))) {
    throw new Error("构建暂存目录必须位于 artifacts/.build-* 下");
  }
  if (await realpath(output) !== output) throw new Error("构建暂存目录不能是链接");
  return output;
}
