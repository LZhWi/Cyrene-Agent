// @vitest-environment jsdom
//
// 接线测试：直接用真实的 settings/index.html 片段，验证 qq-panel 找得到元素、
// 按钮点得动。纯文案的判断在 qq-panel.test.ts，这里专门抓 ID 写错、
// 事件没绑上这类"单测全绿但界面是死的"问题。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const getMusicApiMock = vi.hoisted(() => vi.fn());
vi.mock("./panel", () => ({ getMusicApi: getMusicApiMock }));

import { initQQMusicPanel } from "./qq-panel";

/** 从真实 index.html 里抠出 QQ 音乐那张卡，避免测试里手写一份会漂移的副本。 */
function realCardMarkup(): string {
  const html = readFileSync(
    path.resolve(__dirname, "..", "index.html"),
    "utf8",
  );
  const start = html.indexOf('<article class="plugin-card plugin-card--sub" id="music-platform-qq"');
  expect(start, "index.html 里找不到 music-platform-qq 卡片").toBeGreaterThan(-1);
  const end = html.indexOf("</article>", start) + "</article>".length;
  return html.slice(start, end);
}

const detection = {
  installed: true, installPath: "C:/x", version: "21.11",
  running: true, helperAvailable: true, controllable: true,
  nowPlaying: { title: "下一个天亮", artist: "郭静", album: "下一个天亮", status: "Paused" },
};

function api(over: Record<string, unknown> = {}) {
  return {
    qqDetect: vi.fn(async () => ({ ok: true, data: detection })),
    qqControl: vi.fn(async () => ({ ok: true, data: { applied: "next" } })),
    ...over,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = realCardMarkup();
  getMusicApiMock.mockReset();
});
afterEach(() => { document.body.innerHTML = ""; });

describe("QQ 卡片接线", () => {
  it("初始化后渲染状态、曲目，并显示控制按钮", async () => {
    const a = api();
    getMusicApiMock.mockReturnValue(a);

    initQQMusicPanel();
    await flush();

    expect(a.qqDetect).toHaveBeenCalled();
    expect(document.getElementById("qq-status-line")!.textContent).toContain("已连接");
    expect(document.getElementById("qq-now-playing")!.textContent).toContain("下一个天亮");
    expect(document.getElementById("qq-controls")!.classList.contains("is-hidden")).toBe(false);
    expect(document.getElementById("qq-tag")!.textContent).toBe("已连接");
  });

  it("点下一首会把命令发下去", async () => {
    const a = api();
    getMusicApiMock.mockReturnValue(a);
    initQQMusicPanel();
    await flush();

    (document.querySelector('[data-qq-cmd="next"]') as HTMLElement).click();
    await flush();

    expect(a.qqControl).toHaveBeenCalledWith("next");
  });

  it("控制返回失败时显示错误，而不是假装成功后刷新", async () => {
    const a = api({
      qqControl: vi.fn(async () => ({ ok: false, errorCode: "E_QQ_CONTROL_FAILED" })),
    });
    getMusicApiMock.mockReturnValue(a);
    initQQMusicPanel();
    await flush();

    (document.querySelector('[data-qq-cmd="next"]') as HTMLElement).click();
    await flush();

    expect(document.getElementById("qq-status-line")!.textContent).toContain("控制失败");
    expect(a.qqDetect).toHaveBeenCalledTimes(1);
  });

  it("不可控制时隐藏控制按钮", async () => {
    const a = api({
      qqDetect: vi.fn(async () => ({
        ok: true, data: { ...detection, running: false, controllable: false, nowPlaying: null },
      })),
    });
    getMusicApiMock.mockReturnValue(a);
    initQQMusicPanel();
    await flush();

    expect(document.getElementById("qq-controls")!.classList.contains("is-hidden")).toBe(true);
    expect(document.getElementById("qq-status-line")!.textContent).toContain("打开后即可控制");
  });

  it("重新检测按钮会再查一次", async () => {
    const a = api();
    getMusicApiMock.mockReturnValue(a);
    initQQMusicPanel();
    await flush();
    expect(a.qqDetect).toHaveBeenCalledTimes(1);

    (document.getElementById("qq-refresh") as HTMLElement).click();
    await flush();
    expect(a.qqDetect).toHaveBeenCalledTimes(2);
  });

  it("重复初始化不会重复绑定", async () => {
    const a = api();
    getMusicApiMock.mockReturnValue(a);
    initQQMusicPanel();
    initQQMusicPanel();
    await flush();

    expect(a.qqDetect).toHaveBeenCalledTimes(1);
  });

  it("preload 没暴露 qqDetect 时给出可读提示而不是崩掉", async () => {
    getMusicApiMock.mockReturnValue(null);
    expect(() => initQQMusicPanel()).not.toThrow();
    await flush();
    expect(document.getElementById("qq-status-line")!.textContent).toContain("不支持");
  });
});

// classList 断言证明不了「真的隐藏了」——类加上了，但样式表里没有对应规则的话
// 元素照样显示。这里从真实的 settings.css 里把那条规则抠出来注进 jsdom：
// 既验证规则确实存在于源文件，又验证它真的生效。
//
// 刻意只注入这一条而不是整份 settings.css：整份四千多行让 jsdom 解析要 30 秒以上，
// 为一个断言拖慢整个测试套件不值得。
describe("is-hidden 必须真的隐藏（规则存在且生效）", () => {
  function injectHiddenRule(): void {
    const css = readFileSync(path.resolve(__dirname, "..", "settings.css"), "utf8");
    const m = /.qq-controls.is-hidden[^}]*}/.exec(css);
    expect(m, "settings.css 里找不到 .qq-controls.is-hidden 规则").not.toBeNull();
    const style = document.createElement("style");
    style.textContent = m![0];
    document.head.appendChild(style);
  }

  it("加上 is-hidden 后控制条的 display 为 none", () => {
    injectHiddenRule();
    const controls = document.getElementById("qq-controls")!;

    // 初始 markup 就带 is-hidden
    expect(controls.classList.contains("is-hidden")).toBe(true);
    expect(getComputedStyle(controls).display).toBe("none");

    controls.classList.remove("is-hidden");
    expect(getComputedStyle(controls).display).not.toBe("none");
  });

  it("角标和正在播放行同样在这条规则里", () => {
    injectHiddenRule();
    expect(getComputedStyle(document.getElementById("qq-tag")!).display).toBe("none");
    expect(getComputedStyle(document.getElementById("qq-now-playing")!).display).toBe("none");
  });
});
