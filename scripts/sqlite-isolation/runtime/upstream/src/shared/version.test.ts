import { describe, expect, it } from "vitest";
import { isNewerVersion, isValidPluginVersion } from "./version";

describe("isValidPluginVersion", () => {
  it("接受标准三段数字版本", () => {
    expect(isValidPluginVersion("0.1.0")).toBe(true);
    expect(isValidPluginVersion("1.10.3")).toBe(true);
    expect(isValidPluginVersion(" 0.2.0 ")).toBe(true);
  });

  it("接受完整 SemVer 的预发布号与 build 元数据", () => {
    expect(isValidPluginVersion("1.0.0-beta.1")).toBe(true);
    expect(isValidPluginVersion("0.10.0-beta.1")).toBe(true);
    expect(isValidPluginVersion("1.0.0-alpha")).toBe(true);
    expect(isValidPluginVersion("1.0.0-alpha.beta.1")).toBe(true);
    expect(isValidPluginVersion("1.0.0+build.123")).toBe(true);
    expect(isValidPluginVersion("1.0.0-beta.1+build.456")).toBe(true);
  });

  it("拒绝前导零", () => {
    expect(isValidPluginVersion("01.1.0")).toBe(false);
    expect(isValidPluginVersion("1.01.0")).toBe(false);
    expect(isValidPluginVersion("1.1.00")).toBe(false);
  });

  it("拒绝不完整或畸形版本", () => {
    expect(isValidPluginVersion("1.0")).toBe(false);
    expect(isValidPluginVersion("1.0.0.0")).toBe(false);
    expect(isValidPluginVersion("v1.0.0")).toBe(false);
    expect(isValidPluginVersion("1.a.0")).toBe(false);
    expect(isValidPluginVersion("1.0.0-")).toBe(false);
    expect(isValidPluginVersion("1.0.0-beta..1")).toBe(false);
    expect(isValidPluginVersion("")).toBe(false);
  });
});

describe("isNewerVersion", () => {
  it("逐段数字比较，不受字符串比较误导", () => {
    expect(isNewerVersion("1.10.0", "1.9.0")).toBe(true);
    expect(isNewerVersion("1.9.0", "1.10.0")).toBe(false);
    expect(isNewerVersion("2.0.0", "1.99.99")).toBe(true);
    expect(isNewerVersion("1.0.1", "1.0.0")).toBe(true);
  });

  it("相同版本返回 false", () => {
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
  });

  it("任一版本非法返回 false", () => {
    expect(isNewerVersion("abc", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0")).toBe(false);
  });

  it("预发布低于对应正式版", () => {
    expect(isNewerVersion("0.10.0", "0.10.0-beta.1")).toBe(true);
    expect(isNewerVersion("0.10.0-beta.1", "0.10.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.0-beta")).toBe(true);
  });

  it("预发布标识符按 SemVer 规则排序（数字按数值，字母按 ASCII，数字低于字母）", () => {
    // SemVer 2.0 规范里的经典排序链，逐对验证严格递增
    const chain = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i + 1 < chain.length; i += 1) {
      expect(isNewerVersion(chain[i + 1], chain[i])).toBe(true);
      expect(isNewerVersion(chain[i], chain[i + 1])).toBe(false);
    }
  });

  it("相同版本不同 build 元数据视为同等优先级", () => {
    expect(isNewerVersion("1.0.0+build.2", "1.0.0+build.1")).toBe(false);
    expect(isNewerVersion("1.0.0+build.1", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.0+build.1")).toBe(false);
  });
});
