// 设置页文案测试：三种"用不了"必须给出三种不同的下一步动作。
// 这是这张卡片存在的意义——只说"不可用"等于没说。
import { describe, expect, it } from "vitest";
import { deriveQQViewState as describeDetection } from "../../../shared/qq-view-state";
import type { QQMusicDetectionLike as QQMusicDetection } from "../../../shared/qq-view-state";

const base: QQMusicDetection = {
  installed: true, version: "21.11", running: true, helperAvailable: true,
};

describe("describeDetection", () => {
  it("未安装", () => {
    const { text, tag } = describeDetection({ ...base, installed: false, version: null });
    expect(tag).toBe("未安装");
    expect(text).toContain("未检测到");
  });

  it("控制组件缺失时给出具体命令，而不是泛泛的错误", () => {
    const { text, tag } = describeDetection({ ...base, helperAvailable: false });
    expect(tag).toBe("组件缺失");
    expect(text).toContain("npm run build:media-helper");
  });

  it("装了没开时提示打开播放器", () => {
    const { text, tag } = describeDetection({ ...base, running: false });
    expect(tag).toBe("未运行");
    expect(text).toContain("打开后即可控制");
  });

  it("可用时明确说明不会弹窗", () => {
    const { text, tag } = describeDetection(base);
    expect(tag).toBe("已连接");
    expect(text).toContain("不弹窗");
  });

  it("版本缺失时不留下多余空格", () => {
    const { text } = describeDetection({ ...base, version: null });
    expect(text).not.toMatch(/\s{2,}/);
    expect(text).toContain("已连接");
  });

  // 优先级：组件缺失比"没运行"更根本，应该先报组件缺失。
  it("既没开又缺组件时优先报组件缺失", () => {
    const { tag } = describeDetection({
      ...base, running: false, helperAvailable: false, controllable: false,
    });
    expect(tag).toBe("组件缺失");
  });
});
