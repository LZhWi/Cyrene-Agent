import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../vendors/types";
import {
  compressLocalTwoPhaseTranscript,
  truncateLocalToolResult,
} from "./local-two-phase-transcript";

describe("local two-phase transcript", () => {
  it("uses the local 12000-char head-only tool result rule", () => {
    const value = "x".repeat(12_010);
    const result = truncateLocalToolResult(value);
    expect(result).toBe("x".repeat(12_000) + "\n[truncated: 原始 12010 字符，已截断至 12000 字符]");
  });

  it("removes Harness internal messages before Soul handoff", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "user",
        content: "runtime-only",
        visibility: "internal",
        internal: {
          kind: "run_start",
          revision: 1,
          digest: "digest",
          id: "id",
          runId: "run",
          createdAt: 1,
        },
      },
      { role: "assistant", content: "", toolCalls: [{ id: "call", name: "lookup", arguments: "{}" }] },
      { role: "tool", toolCallId: "call", name: "lookup", content: "result" },
    ];

    expect(compressLocalTwoPhaseTranscript(messages)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "", toolCalls: [{ id: "call", name: "lookup", arguments: "{}" }] },
      { role: "tool", toolCallId: "call", name: "lookup", content: "result" },
    ]);
  });

  it("matches the local 80000-char compression shape and preserves the latest six messages", () => {
    const messages: ChatMessage[] = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "assistant" as const : "tool" as const,
      content: `${index}:` + "x".repeat(10_100),
    }));
    const result = compressLocalTwoPhaseTranscript(messages);

    expect(result).toHaveLength(8);
    expect(result[0].content).toBe("0:" + "x".repeat(198) + "\n[compressed: 原始 10102 字符]");
    expect(result[1].content).toBe("1:" + "x".repeat(198) + "\n[compressed: 原始 10102 字符]");
    expect(result.slice(-6).map((message) => String(message.content).length)).toEqual(Array(6).fill(10_102));
  });
});
