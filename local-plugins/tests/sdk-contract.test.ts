import {
  CURRENT_PLUGIN_API_VERSION,
  PLUGIN_CAPABILITIES,
  PLUGIN_HOST_ERROR_CODES,
} from "@playa0v0/cyrene-plugin-sdk";
import { describe, expect, it } from "vitest";

const requiredCapabilities = [
  "channels",
  "llm",
  "secrets",
  "workspace",
  "conversations",
  "scheduler",
  "speech-input",
] as const;

const requiredErrorCodes = [
  "E_CAPABILITY_UNAVAILABLE",
  "E_INVALID_ARGUMENT",
  "E_NOT_FOUND",
  "E_NOT_OWNER",
  "E_STORAGE_UNAVAILABLE",
  "E_SPEECH_INPUT_BUSY",
  "E_NO_ACTIVE_INPUT_TARGET",
  "E_PLUGIN_STOPPING",
  "E_INTERNAL",
] as const;

describe("官方 SDK 兼容边界", () => {
  it("仍使用 Plugin API v1", () => {
    expect(CURRENT_PLUGIN_API_VERSION).toBe(1);
  });

  it("保留当前插件规划依赖的宿主能力", () => {
    expect(PLUGIN_CAPABILITIES).toEqual(expect.arrayContaining([...requiredCapabilities]));
  });

  it("保留插件错误处理依赖的稳定错误码", () => {
    for (const code of requiredErrorCodes) expect(PLUGIN_HOST_ERROR_CODES.has(code)).toBe(true);
  });
});
