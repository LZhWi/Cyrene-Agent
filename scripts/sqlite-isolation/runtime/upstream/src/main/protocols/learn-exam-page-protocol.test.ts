import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseLearnExamPageRequest, resolveLearnExamPageAsset } from "./learn-exam-page-protocol";

const examId = "exam-123e4567-e89b-12d3-a456-426614174000";

describe("learn exam page protocol", () => {
  it("maps the paper document route to the fixed bundled HTML entry", () => {
    expect(parseLearnExamPageRequest(`cyrene-exam://paper/${examId}`)).toEqual({ kind: "document", examId });
  });

  it("accepts only safe bundled asset paths", () => {
    expect(parseLearnExamPageRequest("cyrene-exam://paper/assets/exam-ab12.css")).toEqual({ kind: "asset", relativePath: "assets/exam-ab12.css" });
    expect(parseLearnExamPageRequest("cyrene-exam://paper/assets/%2e%2e/secret.js")).toBeNull();
    expect(parseLearnExamPageRequest("cyrene-exam://paper/other.html")).toBeNull();
    expect(parseLearnExamPageRequest("https://paper.example/assets/exam.css")).toBeNull();
  });

  it("allows safe Vite module requests only in development mode", () => {
    expect(parseLearnExamPageRequest("cyrene-exam://paper/learn-exam-preview.tsx", { allowViteDevRequests: true }))
      .toEqual({ kind: "asset", relativePath: "learn-exam-preview.tsx" });
    expect(parseLearnExamPageRequest("cyrene-exam://paper/react/components/Card.tsx", { allowViteDevRequests: true }))
      .toEqual({ kind: "asset", relativePath: "react/components/Card.tsx" });
    expect(parseLearnExamPageRequest("cyrene-exam://paper/%2e%2e/secret.js", { allowViteDevRequests: true })).toBeNull();
    expect(parseLearnExamPageRequest("cyrene-exam://paper/learn-exam-preview.tsx")).toBeNull();
  });

  it("allows only Vite's Windows @fs drive prefix in development requests", () => {
    expect(parseLearnExamPageRequest("cyrene-exam://paper/@fs/E:/Cyrene-Agent/node_modules/.vite/deps/react.js?v=abc", { allowViteDevRequests: true }))
      .toEqual({ kind: "asset", relativePath: "@fs/E:/Cyrene-Agent/node_modules/.vite/deps/react.js", search: "?v=abc" });
    expect(parseLearnExamPageRequest("cyrene-exam://paper/@fs/E:/../secret.js", { allowViteDevRequests: true })).toBeNull();
    expect(parseLearnExamPageRequest("cyrene-exam://paper/@fs/E:/secret.js")).toBeNull();
    expect(parseLearnExamPageRequest("cyrene-exam://paper/other:thing.js", { allowViteDevRequests: true })).toBeNull();
  });

  it("resolves an asset under the renderer root and blocks traversal", () => {
    const root = path.resolve("dist/renderer");
    expect(resolveLearnExamPageAsset(root, "assets/exam.css")).toBe(path.join(root, "assets", "exam.css"));
    expect(resolveLearnExamPageAsset(root, "assets/../../main/index.js")).toBeNull();
    expect(resolveLearnExamPageAsset(root, "../package.json")).toBeNull();
  });
});
