import { describe, expect, test } from "vitest";
import { OpenAICompatAdapter } from "./openai-adapter";
import type { ProviderCapability } from "./types";

const capability: ProviderCapability = {
  id: "test-openai",
  displayName: "Test OpenAI",
  transport: "openai",
  baseUrl: "https://example.test/v1",
  authStyle: "bearer",
  defaultModel: "test-model",
  supportsTools: true,
  supportsThinking: false,
  thinkingField: null,
  cacheStrategy: "none",
  testStrategy: "text",
  supportsVision: true,
};

describe("OpenAICompatAdapter", () => {
  test("maps an explicit required tool to OpenAI tool_choice", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const req = adapter.buildRequest({
      model: "m",
      messages: [{ role: "user", content: "搜歌" }],
      tools: [{ name: "music_search", description: "搜索", parameters: { type: "object" } }],
      toolChoice: { name: "music_search" },
    }, { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "sk-test" });

    expect(JSON.parse(req.body).tool_choice).toEqual({
      type: "function",
      function: { name: "music_search" },
    });
  });

  test("preserves user content blocks for direct image attachments", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const request = adapter.buildRequest(
      {
        model: "test-model",
        messages: [
          { role: "system", content: "system" },
          {
            role: "user",
            content: [
              { type: "text", text: "请看图" },
              { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
            ],
          },
        ],
      },
      {
        provider: "Test OpenAI",
        baseUrl: "https://example.test/v1",
        model: "test-model",
        apiKey: "key",
      },
    );

    const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "请看图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    });
  });

  test("buildRequest uses Authorization Bearer when authStyle=bearer", () => {
    const adapter = new OpenAICompatAdapter("test-openai", { ...capability, authStyle: "bearer" });
    const req = adapter.buildRequest(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "sk-test" },
    );
    expect(req.headers.Authorization).toBe("Bearer sk-test");
    expect(req.headers["x-api-key"]).toBeUndefined();
  });

  test("buildRequest uses x-api-key when authStyle=x-api-key (transport=openai decoupled)", () => {
    const adapter = new OpenAICompatAdapter("test-openai", { ...capability, authStyle: "x-api-key" });
    const req = adapter.buildRequest(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "sk-test" },
    );
    expect(req.headers["x-api-key"]).toBe("sk-test");
    expect(req.headers.Authorization).toBeUndefined();
  });

  // ─── 流式 / 非流式 reasoning_content 解析（覆盖 DeepSeek / Qwen / GLM / MiMo /volcengine） ───

  test("parseStreamEvent: delta.reasoning_content → chunk.deltaThinking（DeepSeek/Qwen/GLM/MiMo 流式）", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const chunk = adapter.parseStreamEvent({
      eventType: "data",
      data: JSON.stringify({ choices: [{ delta: { reasoning_content: "我在思考" } }] }),
    });
    expect(chunk?.deltaThinking).toBe("我在思考");
    expect(chunk?.deltaText).toBeUndefined();
  });

  test("parseStreamEvent: delta.content → chunk.deltaText（不影响 reasoning_content）", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const chunk = adapter.parseStreamEvent({
      eventType: "data",
      data: JSON.stringify({ choices: [{ delta: { content: "你好" } }] }),
    });
    expect(chunk?.deltaText).toBe("你好");
    expect(chunk?.deltaThinking).toBeUndefined();
  });

  test("parseStreamEvent: [DONE] 哨兵 → chunk.done=true", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const chunk = adapter.parseStreamEvent({ eventType: "data", data: "[DONE]" });
    expect(chunk?.done).toBe(true);
  });

  test("parseStreamEvent: usage 块（choices 为空但有 usage）→ chunk.usage", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const chunk = adapter.parseStreamEvent({
      eventType: "data",
      data: JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 20 } }),
    });
    expect(chunk?.usage).toEqual({ input: 10, output: 20 });
  });

  test("parseStreamEvent: usage 块带 cached_tokens（Kimi 顶层字段）→ chunk.usage.cachedInput", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const chunk = adapter.parseStreamEvent({
      eventType: "data",
      data: JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 80 } }),
    });
    expect(chunk?.usage).toEqual({ input: 100, output: 20, cachedInput: 80 });
  });

  test("parseResponse: 同时返回 reasoning_content 与 content → assistantMessage 双字段", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const resp = adapter.parseResponse({
      choices: [{
        message: {
          role: "assistant",
          content: "最终答案",
          reasoning_content: "思考过程",
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
    });
    expect(resp.text).toBe("最终答案");
    expect(resp.thinking).toBe("思考过程");
    expect(resp.assistantMessage.thinking).toBe("思考过程");
    expect(resp.assistantMessage.content).toBe("最终答案");
    expect(resp.usage).toEqual({ input: 5, output: 10 });
    expect(resp.finishReason).toBe("stop");
  });

  test("parseResponse: tool_calls 多轮字段映射正确", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const resp = adapter.parseResponse({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "tc1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"北京"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    });
    expect(resp.toolCalls).toEqual([
      { id: "tc1", name: "get_weather", arguments: '{"city":"北京"}' },
    ]);
    expect(resp.finishReason).toBe("tool_calls");
    expect(resp.assistantMessage.toolCalls).toEqual(resp.toolCalls);
  });

  // ─── 缓存命中数解析 + 缓存 key 分阶段 ───

  test("parseResponse: Kimi 顶层 cached_tokens → usage.cachedInput；未上报时无该字段", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const withCached = adapter.parseResponse({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 50, cached_tokens: 900 },
    });
    expect(withCached.usage).toEqual({ input: 1000, output: 50, cachedInput: 900 });

    const noCached = adapter.parseResponse({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 50 },
    });
    expect(noCached.usage).toEqual({ input: 1000, output: 50 });
    expect(noCached.usage).not.toHaveProperty("cachedInput");
  });

  test("parseResponse: OpenAI 官方格式 prompt_tokens_details.cached_tokens 优先于顶层字段", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const resp = adapter.parseResponse({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 768 } },
    });
    expect(resp.usage?.cachedInput).toBe(768);
  });

  test("applyCacheHints: 按阶段拆 key（带 tools → :tool，不带 → :soul）；非 prompt_cache_key 厂商不动请求", () => {
    const kimiLike = new OpenAICompatAdapter("kimi", { ...capability, id: "kimi", cacheStrategy: "prompt_cache_key" });
    const toolReq = kimiLike.applyCacheHints(
      { model: "m", messages: [], tools: [{ name: "t", description: "d", parameters: {} }] },
      { provider: "p", baseUrl: "u", model: "m", apiKey: "k" },
    );
    expect(toolReq.extraBody?.prompt_cache_key).toBe("cyrene:kimi:tool");

    const soulReq = kimiLike.applyCacheHints(
      { model: "m", messages: [] },
      { provider: "p", baseUrl: "u", model: "m", apiKey: "k" },
    );
    expect(soulReq.extraBody?.prompt_cache_key).toBe("cyrene:kimi:soul");

    // cacheStrategy=none（默认 capability）：原样返回，不注入 extraBody
    const plain = new OpenAICompatAdapter("test-openai", capability);
    const untouched = plain.applyCacheHints(
      { model: "m", messages: [] },
      { provider: "p", baseUrl: "u", model: "m", apiKey: "k" },
    );
    expect(untouched.extraBody).toBeUndefined();
  });

  // ─── 多轮工具调用：appendToolResults + buildRequest 端到端 ───

  test("多轮工具调用：assistant 带 toolCalls → appendToolResults → buildRequest 的 wire messages 顺序与字段完整", () => {
    const adapter = new OpenAICompatAdapter("test-openai", capability);
    const messages = [
      { role: "user" as const, content: "北京天气如何" },
      {
        role: "assistant" as const,
        content: undefined,
        toolCalls: [{ id: "tc1", name: "get_weather", arguments: '{"city":"北京"}' }],
      },
      { role: "tool" as const, toolCallId: "tc1", name: "get_weather", content: "晴 25°C" },
      { role: "user" as const, content: "那上海呢" },
    ];
    const req = adapter.buildRequest(
      { model: "test-model", messages },
      { provider: "Test", baseUrl: "https://e.test/v1", model: "test-model", apiKey: "k" },
    );
    const body = JSON.parse(req.body) as { messages: Array<Record<string, unknown>> };
    expect(body.messages).toHaveLength(4);
    // 第 1 条 user
    expect(body.messages[0]).toEqual({ role: "user", content: "北京天气如何" });
    // 第 2 条 assistant 带 tool_calls（adapter: m.content || null → wire 上是 null）
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "tc1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"北京"}' },
      }],
    });
    // 第 3 条 tool 带 tool_call_id 与 name（OpenAI 多轮必须）
    expect(body.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "tc1",
      content: "晴 25°C",
      name: "get_weather",
    });
    // 第 4 条 user 顺序在最后
    expect(body.messages[3]).toEqual({ role: "user", content: "那上海呢" });
  });

  test("DeepSeek 多轮工具调用：assistant 的 reasoning_content 会原样回传", () => {
    const deepSeekCapability: ProviderCapability = {
      ...capability,
      id: "deepseek",
      displayName: "DeepSeek（深度求索）",
      supportsThinking: true,
      thinkingField: "reasoning_content",
    };
    const adapter = new OpenAICompatAdapter("deepseek", deepSeekCapability);
    const messages = [
      { role: "user" as const, content: "苏州天气如何" },
      {
        role: "assistant" as const,
        content: undefined,
        thinking: "需要调用天气工具查询苏州天气。",
        toolCalls: [{ id: "tc-weather", name: "weather", arguments: '{"city":"苏州"}' }],
      },
      { role: "tool" as const, toolCallId: "tc-weather", name: "weather", content: "晴 37.6°C" },
    ];

    const req = adapter.buildRequest(
      { model: "deepseek-v4-flash", messages },
      {
        provider: deepSeekCapability.displayName,
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        apiKey: "k",
        reasoning: { mode: "off" },
      },
    );
    const body = JSON.parse(req.body) as { messages: Array<Record<string, unknown>> };

    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "需要调用天气工具查询苏州天气。",
      tool_calls: [{
        id: "tc-weather",
        type: "function",
        function: { name: "weather", arguments: '{"city":"苏州"}' },
      }],
    });
  });

  test("Kimi 多步工具调用：保留 reasoning_content 且不改变 prompt_cache_key", () => {
    const kimiCapability: ProviderCapability = {
      ...capability,
      id: "kimi",
      displayName: "Kimi（月之暗面）",
      supportsThinking: true,
      thinkingField: "reasoning_content",
      cacheStrategy: "prompt_cache_key",
    };
    const adapter = new OpenAICompatAdapter("kimi", kimiCapability);
    const messages = [
      { role: "user" as const, content: "查询苏州天气" },
      {
        role: "assistant" as const,
        content: undefined,
        thinking: "需要查询实时天气。",
        toolCalls: [{ id: "tc-weather", name: "weather", arguments: '{"city":"苏州"}' }],
      },
      { role: "tool" as const, toolCallId: "tc-weather", name: "weather", content: "晴 37.6°C" },
    ];
    const requestWithCache = adapter.applyCacheHints(
      {
        model: "kimi-k2.7-code",
        messages,
        tools: [{ name: "weather", description: "查询天气", parameters: { type: "object" } }],
      },
      {
        provider: kimiCapability.displayName,
        baseUrl: "https://api.moonshot.cn/v1",
        model: "kimi-k2.7-code",
        apiKey: "k",
      },
    );

    const req = adapter.buildRequest(requestWithCache, {
      provider: kimiCapability.displayName,
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.7-code",
      apiKey: "k",
    });
    const body = JSON.parse(req.body) as {
      prompt_cache_key?: string;
      messages: Array<Record<string, unknown>>;
    };

    expect(body.prompt_cache_key).toBe("cyrene:kimi:tool");
    expect(body.messages[1].reasoning_content).toBe("需要查询实时天气。");
    expect(body.messages[1]).not.toHaveProperty("thinking");
  });

  test.each(["deepseek", "glm", "qwen", "chatgpt", "mimo"])(
    "%s 自动缓存：推理历史不注入显式缓存字段且稳定前缀不变",
    (providerId) => {
      const autoCapability: ProviderCapability = {
        ...capability,
        id: providerId,
        displayName: providerId,
        supportsThinking: true,
        thinkingField: "reasoning_content",
        cacheStrategy: "auto",
      };
      const adapter = new OpenAICompatAdapter(providerId, autoCapability);
      const req = adapter.buildRequest(
        {
          model: "model",
          messages: [
            { role: "system", content: "稳定系统提示" },
            { role: "user", content: "查询天气" },
            { role: "assistant", content: "", thinking: "动态推理历史" },
          ],
        },
        { provider: providerId, baseUrl: "https://e.test/v1", model: "model", apiKey: "k" },
      );
      const body = JSON.parse(req.body) as {
        messages: Array<Record<string, unknown>>;
      } & Record<string, unknown>;

      expect(body.messages.slice(0, 2)).toEqual([
        { role: "system", content: "稳定系统提示" },
        { role: "user", content: "查询天气" },
      ]);
      expect(body.messages[2].reasoning_content).toBe("动态推理历史");
      expect(body).not.toHaveProperty("prompt_cache_key");
      expect(body).not.toHaveProperty("cache_control");
    },
  );
});
