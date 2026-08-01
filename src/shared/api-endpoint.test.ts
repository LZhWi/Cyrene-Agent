import { describe, expect, it } from "vitest";
import { resolveApiEndpoint } from "./api-endpoint";

describe("resolveApiEndpoint", () => {
  it("appends the OpenAI Chat Completions suffix", () => {
    expect(resolveApiEndpoint("https://api.deepseek.com", "openai")).toEqual({
      url: "https://api.deepseek.com/chat/completions",
      appendedSuffix: "/chat/completions",
    });
  });

  it("does not duplicate a complete OpenAI endpoint", () => {
    expect(resolveApiEndpoint("https://api.deepseek.com/chat/completions/", "openai")).toEqual({
      url: "https://api.deepseek.com/chat/completions",
      appendedSuffix: null,
    });
  });

  it("appends only /messages when an Anthropic base URL already ends in /v1", () => {
    expect(resolveApiEndpoint("https://api.anthropic.com/v1", "anthropic")).toEqual({
      url: "https://api.anthropic.com/v1/messages",
      appendedSuffix: "/messages",
    });
  });

  it("appends /v1/messages to an Anthropic host or compatibility prefix", () => {
    expect(resolveApiEndpoint("https://example.com/anthropic", "anthropic")).toEqual({
      url: "https://example.com/anthropic/v1/messages",
      appendedSuffix: "/v1/messages",
    });
  });

  it("does not duplicate a complete Anthropic endpoint", () => {
    expect(resolveApiEndpoint("https://api.anthropic.com/v1/messages", "anthropic")).toEqual({
      url: "https://api.anthropic.com/v1/messages",
      appendedSuffix: null,
    });
  });
});
