import path from "node:path";

const EXAM_ID_PATTERN = /^exam-[0-9a-f-]{36}$/i;
const ASSET_EXTENSION_PATTERN = /\.(?:js|mjs|css|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf)$/i;

export type LearnExamPageRequest = { kind: "document"; examId: string } | { kind: "asset"; relativePath: string; search?: string };

export function parseLearnExamPageRequest(requestUrl: string, options: { allowViteDevRequests?: boolean } = {}): LearnExamPageRequest | null {
  try {
    // URL 会在暴露 pathname 前规范化 ../，因此先检查原始 URL 路径，避免编码后的穿越被悄悄折叠。
    const rawPath = requestUrl.match(/^cyrene-exam:\/\/paper(\/[^?#]*)?(?:[?#]|$)/i)?.[1] ?? "/";
    for (const rawSegment of rawPath.split("/")) {
      const decodedSegment = decodeURIComponent(rawSegment);
      if (decodedSegment === "." || decodedSegment === ".." || /[\\/\0]/.test(decodedSegment)) return null;
    }
    const url = new URL(requestUrl);
    if (url.protocol !== "cyrene-exam:" || url.hostname !== "paper" || url.username || url.password || url.port || url.hash) return null;
    if (url.search && !options.allowViteDevRequests) return null;
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes("\\") || pathname.includes("\0")) return null;
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length === 1 && EXAM_ID_PATTERN.test(segments[0]) && !url.search) return { kind: "document", examId: segments[0] };
    if (segments.length >= 2 && segments[0] === "assets" && segments.every((segment) => segment !== "." && segment !== ".." && !segment.includes(":"))) {
      const relativePath = segments.join("/");
      if (ASSET_EXTENSION_PATTERN.test(relativePath)) return { kind: "asset", relativePath, ...(url.search ? { search: url.search } : {}) };
    }
    const hasOnlySafeSegments = segments.every((segment) => segment !== "." && segment !== ".." && !segment.includes(":"));
    const isViteWindowsFsPath = segments[0] === "@fs"
      && /^[a-z]:$/i.test(segments[1] ?? "")
      && segments.slice(2).every((segment) => segment !== "." && segment !== ".." && !segment.includes(":"));
    if (options.allowViteDevRequests && segments.length > 0 && (hasOnlySafeSegments || isViteWindowsFsPath)) {
      const relativePath = segments.join("/");
      return { kind: "asset", relativePath, ...(url.search ? { search: url.search } : {}) };
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveLearnExamPageAsset(rendererRoot: string, relativePath: string): string | null {
  if (!relativePath.startsWith("assets/") || relativePath.includes("\\") || relativePath.includes("\0")) return null;
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":")) || !ASSET_EXTENSION_PATTERN.test(relativePath)) return null;
  const root = path.resolve(rendererRoot);
  const resolved = path.resolve(root, relativePath);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}
