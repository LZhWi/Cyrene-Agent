/**
 * 插件设置面板静态资源协议（cyrene-plugin://<插件id>/<相对路径>）。
 *
 * 安全模型：
 * - 协议只做纯静态文件服务，不改写 HTML、不注入内容；主题链路走 Panel Bridge。
 * - 仅服务「已扫描 + 已启用 + manifest.settingsPanel 校验通过」的插件目录，
 *   禁用插件的请求立即 404（查询函数由 PluginManager 注入）。
 * - 保留路径 /.cyrene/* 永远不读插件目录，只从宿主资产目录应答（如
 *   panel-bridge.js）；插件目录内存在同名文件时仍以保留路径优先。
 * - 路径安全：URL 段解码后逐段校验（拒绝 `.`/`..`、斜杠、反斜杠、NUL、
 *   盘符形态），最终以 realpath + path.relative 判定不逃逸插件目录；
 *   绝不使用字符串 startsWith 前缀判断（`foo` 与 `foobar` 的经典前缀绕过）。
 * - 扩展名白名单决定内容类型，白名单外一律 404。
 *
 * 同源不变量：设置页（file:// 或 http://localhost）与 cyrene-plugin://
 * 结构性不同源——这是 sandbox iframe 使用 allow-scripts allow-same-origin
 * 的安全前提；修改 scheme 命名或设置页加载方式前必须重新评估。
 * 注意 origin 序列化差异：渲染进程中 Chromium 对注册为 standard 的
 * 自定义 scheme 给出 cyrene-plugin://<host> 形态的 event.origin，
 * 而 Node 的 URL.origin 对该 scheme 返回 "null"（opaque 序列化），
 * 相关断言不能在 Node 环境直接复用渲染进程行为。
 *
 * 生命周期：registerPluginPanelScheme 必须在 app.ready 之前调用（模块顶层），
 * installPluginPanelProtocol 必须在 ready 之后调用，两个函数不得调换时机。
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { protocol } from "electron";

const PLUGIN_PANEL_SCHEME = "cyrene-plugin";
/** URL 第一段命中该保留段时不读插件目录，改由宿主资产目录应答。 */
const RESERVED_SEGMENT = ".cyrene";
/** 与 loader.ts 的 ID_RE 一致：插件 id 充当 URL host，必须是 host-safe 标识符。 */
const PLUGIN_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 扩展名白名单；不在表内的资源一律 404，避免把任意文件当面板内容分发。 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface PluginPanelSuccess {
  status: 200;
  contentType: string;
  body: Buffer;
}

export type PluginPanelResponse = PluginPanelSuccess | { status: 404 };

const NOT_FOUND: { status: 404 } = { status: 404 };

/** 协议层访问查询：仅已启用且声明了合法设置面板的插件返回其目录路径。 */
export type PluginPanelAccessQuery = (pluginId: string) => string | undefined;

/**
 * 解码单个 URL 路径段并做安全校验。解码只做一次：`%2f`/`%5c` 解码出的
 * 斜杠与反斜杠会被拒绝，`%252e` 之类的双重编码只产生字面 `%2e` 文件名
 * （找不到即 404），不会被二次解码成 `.`
 */
function decodeSegment(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (
    decoded === ""
    || decoded === "."
    || decoded === ".."
    || decoded.includes("/")
    || decoded.includes("\\")
    || decoded.includes("\0")
    || /^[a-zA-Z]:/.test(decoded)
  ) {
    return null;
  }
  return decoded;
}

/** 在受信任根目录内解析白名单静态文件；任何一步不满足都 404。 */
async function serveFileFromRoot(
  root: string,
  segments: string[],
): Promise<PluginPanelResponse> {
  if (segments.length === 0) return NOT_FOUND;
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return NOT_FOUND;
  }
  // 段内已拒绝 .. 与绝对路径成分，join 只做拼接与规范化
  const candidate = path.join(realRoot, ...segments);
  let realTarget: string;
  try {
    realTarget = await realpath(candidate);
  } catch {
    return NOT_FOUND;
  }
  // 防符号链接逃逸：目标必须落在真实根目录之内（相对路径判定，非字符串前缀）
  const rel = path.relative(realRoot, realTarget);
  if (
    rel === ""
    || rel === ".."
    || rel.startsWith(`..${path.sep}`)
    || path.isAbsolute(rel)
  ) {
    return NOT_FOUND;
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(realTarget);
  } catch {
    return NOT_FOUND;
  }
  if (!info.isFile()) return NOT_FOUND;
  const contentType = CONTENT_TYPES[path.extname(realTarget).toLowerCase()];
  if (!contentType) return NOT_FOUND;
  const body = await readFile(realTarget);
  return { status: 200, contentType, body };
}

/**
 * 协议核心解析（纯函数，便于安全测试）：URL → 静态资源响应。
 * 查询 query 决定「插件存在且已启用」，assetsRoot 是宿主保留资产的目录。
 */
export async function resolvePluginPanelRequest(
  rawUrl: string,
  query: PluginPanelAccessQuery,
  assetsRoot: string,
): Promise<PluginPanelResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return NOT_FOUND;
  }
  if (url.protocol !== `${PLUGIN_PANEL_SCHEME}:`) return NOT_FOUND;

  const rawSegments = url.pathname.split("/");
  // 合法请求的 pathname 必须以 / 开头（split 后首段为空）
  if (rawSegments[0] !== "") return NOT_FOUND;
  const segments: string[] = [];
  for (const raw of rawSegments.slice(1)) {
    const decoded = decodeSegment(raw);
    if (decoded === null) return NOT_FOUND;
    segments.push(decoded);
  }
  if (segments.length === 0) return NOT_FOUND;

  // 保留路径：只从宿主资产目录应答，永不读取插件目录
  if (segments[0] === RESERVED_SEGMENT) {
    return serveFileFromRoot(assetsRoot, segments.slice(1));
  }

  // 插件静态资源：URL host 即插件 id（hostname 形态校验，大写/特殊字符直接 404）
  const pluginId = url.hostname;
  if (!PLUGIN_ID_RE.test(pluginId)) return NOT_FOUND;
  const pluginDir = query(pluginId);
  if (!pluginDir) return NOT_FOUND;
  return serveFileFromRoot(pluginDir, segments);
}

/** 应用入口模块顶层调用（app.ready 之前）：注册 scheme 特权。 */
export function registerPluginPanelScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_PANEL_SCHEME,
      // 最小权限：standard 支持面板内相对资源解析（./xxx.js）；secure 获得
      // 安全上下文。不开 supportFetchAPI：面板与主进程通信统一走 Panel Bridge。
      privileges: { standard: true, secure: true },
    },
  ]);
}

/** app.whenReady() 之后调用：安装静态文件 handler。 */
export function installPluginPanelProtocol(query: PluginPanelAccessQuery): void {
  // 宿主资产（panel-bridge.js 等）随构建复制到 dist/main/plugin-panel/；
  // 本文件编译产物在 dist/main/main/ 下，需回上一层才是资产目录
  const assetsRoot = path.join(__dirname, "..", "plugin-panel");
  protocol.handle(PLUGIN_PANEL_SCHEME, async (request) => {
    const result = await resolvePluginPanelRequest(request.url, query, assetsRoot);
    if (result.status === 404) {
      return new Response(null, { status: 404 });
    }
    return new Response(result.body, {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  });
}
