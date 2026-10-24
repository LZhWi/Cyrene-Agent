import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
}));

import { protocol } from "electron";
import {
  installPluginPanelProtocol,
  registerPluginPanelScheme,
  resolvePluginPanelRequest,
  type PluginPanelAccessQuery,
} from "./plugin-panel-protocol";

let tmp: string;
let pluginDir: string;
let assetsDir: string;
/** 模拟 PluginManager 注入：demo 已启用且有面板，ghost 已禁用，其余未知。 */
let query: PluginPanelAccessQuery;

// Windows 普通用户创建文件符号链接需要开发者模式；不支持时跳过相关用例
let symlinkSupported = false;
try {
  const probe = `${__filename}.link-probe`;
  symlinkSync(__filename, probe);
  rmSync(probe);
  symlinkSupported = true;
} catch {
  symlinkSupported = false;
}

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-panel-protocol-test-"));
  pluginDir = path.join(tmp, "plugins", "demo");
  assetsDir = path.join(tmp, "assets");
  mkdirSync(pluginDir, { recursive: true });
  mkdirSync(path.join(tmp, "plugins", "ghost"), { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(path.join(pluginDir, "ui.html"), "<!doctype html><p>demo-panel</p>", "utf8");
  writeFileSync(path.join(pluginDir, "app.js"), "// js", "utf8");
  writeFileSync(path.join(pluginDir, "style.css"), "p{}", "utf8");
  writeFileSync(path.join(pluginDir, "pic.svg"), "<svg/>", "utf8");
  writeFileSync(path.join(pluginDir, "data.bin"), "binary", "utf8");
  mkdirSync(path.join(pluginDir, ".cyrene"), { recursive: true });
  writeFileSync(path.join(pluginDir, ".cyrene", "panel-bridge.js"), "PLUGIN-OWNED", "utf8");
  writeFileSync(path.join(tmp, "plugins", "ghost", "ui.html"), "ghost-panel", "utf8");
  writeFileSync(path.join(assetsDir, "panel-bridge.js"), "HOST-ASSET", "utf8");
  query = (id) => (id === "demo" ? pluginDir : undefined);
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

function panelUrl(rawUrl: string): Promise<ReturnType<typeof resolvePluginPanelRequest>> {
  return resolvePluginPanelRequest(rawUrl, query, assetsDir);
}

describe("resolvePluginPanelRequest：静态资源路由", () => {
  it("合法面板 HTML 与白名单资源正常返回并带正确内容类型", async () => {
    const html = await panelUrl("cyrene-plugin://demo/ui.html");
    expect(html).toMatchObject({ status: 200, contentType: "text/html; charset=utf-8" });
    expect((html as { body: Buffer }).body.toString("utf8")).toContain("demo-panel");

    for (const [file, type] of [
      ["app.js", "text/javascript; charset=utf-8"],
      ["style.css", "text/css; charset=utf-8"],
      ["pic.svg", "image/svg+xml"],
    ] as const) {
      const res = await panelUrl(`cyrene-plugin://demo/${file}`);
      expect(res).toMatchObject({ status: 200, contentType: type });
    }
  });

  it("查询串与 hash 不影响路由", async () => {
    const res = await panelUrl("cyrene-plugin://demo/ui.html?v=1#frag");
    expect(res.status).toBe(200);
  });

  it("扩展名白名单外的文件一律 404", async () => {
    expect((await panelUrl("cyrene-plugin://demo/data.bin")).status).toBe(404);
  });

  it("未知插件与禁用插件 404", async () => {
    expect((await panelUrl("cyrene-plugin://nobody/ui.html")).status).toBe(404);
    expect((await panelUrl("cyrene-plugin://ghost/ui.html")).status).toBe(404);
  });

  it("目录路径、双斜杠空段 404", async () => {
    expect((await panelUrl("cyrene-plugin://demo/")).status).toBe(404);
    expect((await panelUrl("cyrene-plugin://demo//ui.html")).status).toBe(404);
  });

  it("段含解码斜杠或反斜杠（%2f / %5c / ..%5c）404", async () => {
    expect((await panelUrl("cyrene-plugin://demo/ui%2fhtml")).status).toBe(404);
    expect((await panelUrl("cyrene-plugin://demo/ui%5chtml")).status).toBe(404);
    expect((await panelUrl("cyrene-plugin://demo/..%5csecret")).status).toBe(404);
  });

  it("NUL 字节与双重编码只产生字面文件名，找不到即 404", async () => {
    expect((await panelUrl("cyrene-plugin://demo/ui%00.html")).status).toBe(404);
    const res = await panelUrl("cyrene-plugin://demo/%252e%252e%252fui.html");
    expect(res.status).toBe(404);
  });

  it("盘符形态段与非法 host 一律 404", async () => {
    expect((await panelUrl("cyrene-plugin://demo/C:/x")).status).toBe(404);
    // non-special scheme 不做 host 小写归一，大写 id 无法通过 hostname 校验
    expect((await panelUrl("cyrene-plugin://DEMO/ui.html")).status).toBe(404);
    expect((await panelUrl("cyrene-plugin://de_mo/ui.html")).status).toBe(404);
  });

  it("URL 层的 .. 规范化等价于直接请求（不允许借此越出插件目录）", async () => {
    const res = await panelUrl("cyrene-plugin://demo/sub/../ui.html");
    expect(res.status).toBe(200);
  });

  it("opaque path（无 authority）与外部协议、非法 URL 404", async () => {
    expect((await panelUrl("cyrene-plugin:demo/ui.html")).status).toBe(404);
    expect((await panelUrl("https://demo/ui.html")).status).toBe(404);
    expect((await panelUrl("not a url")).status).toBe(404);
  });

  it.skipIf(!symlinkSupported)("符号链接逃逸被 realpath 拦截", async () => {
    const outside = path.join(tmp, "outside.html");
    writeFileSync(outside, "outside-secret", "utf8");
    symlinkSync(outside, path.join(pluginDir, "escape.html"));
    expect((await panelUrl("cyrene-plugin://demo/escape.html")).status).toBe(404);
  });
});

describe("resolvePluginPanelRequest：保留路径 /.cyrene/*", () => {
  it("从宿主资产目录应答", async () => {
    const res = await panelUrl("cyrene-plugin://demo/.cyrene/panel-bridge.js");
    expect(res).toMatchObject({ status: 200, contentType: "text/javascript; charset=utf-8" });
    expect((res as { body: Buffer }).body.toString("utf8")).toBe("HOST-ASSET");
  });

  it("保留路径优先于插件目录内同名文件", async () => {
    const res = await panelUrl("cyrene-plugin://demo/.cyrene/panel-bridge.js");
    expect((res as { body: Buffer }).body.toString("utf8")).toBe("HOST-ASSET");
  });

  it("保留路径下不存在的资产与白名单外扩展 404", async () => {
    expect((await panelUrl("cyrene-plugin://demo/.cyrene/nope.js")).status).toBe(404);
    expect((await panelUrl("cyrene-plugin://demo/.cyrene/secret.txt")).status).toBe(404);
  });
});

describe("registerPluginPanelScheme", () => {
  it("注册 standard + secure 且不开 supportFetchAPI", () => {
    registerPluginPanelScheme();
    const schemeArg = vi.mocked(protocol.registerSchemesAsPrivileged).mock.calls[0][0][0];
    expect(schemeArg.scheme).toBe("cyrene-plugin");
    expect(schemeArg.privileges).toEqual({ standard: true, secure: true });
  });
});

describe("installPluginPanelProtocol", () => {
  it("把 handler 装到 cyrene-plugin 并包装响应头", async () => {
    installPluginPanelProtocol(query);
    const handler = vi.mocked(protocol.handle).mock.calls[0][1];
    // install 的默认资产目录是 dist/main/plugin-panel（本测试环境不存在），
    // 保留路径应 404；插件静态资源正常服务
    const ok = await handler({ url: "cyrene-plugin://demo/ui.html" } as never);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(ok.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    expect(await ok.text()).toContain("demo-panel");

    const missing = await handler({ url: "cyrene-plugin://ghost/ui.html" } as never);
    expect(missing.status).toBe(404);
  });
});

describe("同源不变量", () => {
  it("面板 scheme 与设置页 scheme 结构性不相交", () => {
    // Node 的 URL 对未注册的 non-special scheme 序列化 origin 为 "null"
    //（opaque 序列化），渲染进程中 Chromium 对注册为 standard 的自定义
    // scheme 才给出 cyrene-plugin://<host> 形态的 event.origin。
    // 本测试固化结构性前提：面板 scheme 是自定义 scheme，设置页以
    // file://（打包）或 http(s)://（开发/远端）加载，两者不可能同源——
    // 这是 sandbox iframe 使用 allow-scripts allow-same-origin 的安全前提。
    const panel = new URL("cyrene-plugin://demo/ui.html");
    expect(panel.protocol).toBe("cyrene-plugin:");
    for (const settingsOrigin of ["file://", "http://localhost:5173", "https://app.example"]) {
      expect(settingsOrigin.startsWith(panel.protocol)).toBe(false);
    }
  });
});
